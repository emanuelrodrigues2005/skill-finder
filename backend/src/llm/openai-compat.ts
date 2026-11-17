/**
 * Cliente do provedor OpenAI-compatible (`docs/app/02-arquitetura.md` §6.3 e §8.3).
 *
 * Usa **axios** de propósito: o `nock` intercepta `http.request`, e o setup do
 * Jest roda com `nock.disableNetConnect()` (regra 5). Um cliente baseado em
 * `fetch` passaria por fora desse bloqueio e a suíte mentiria.
 *
 * Regras da chamada:
 *   - `POST {baseUrl}/chat/completions`, sem streaming e sem tools;
 *   - `temperature: 0.2` e `max_tokens: 256`: a tarefa é extração, não redação;
 *   - `response_format: {type: 'json_object'}` (ADR-004);
 *   - timeout de `timeoutS` segundos, **1** retry só para rede/429/5xx com ~250 ms
 *     de espera; timeout nunca é retentado (o usuário já esperou o suficiente);
 *   - falha vira `unavailable` + `Intent` lexical, para a busca não morrer (§7.4).
 *
 * Nada de header, corpo ou chave em log — e a mensagem do provedor (que pode
 * citar a chave em um 401) nunca entra no resultado (regra 4).
 */
import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';

import type { TokenUsage } from '@/contract/dto/search-response.dto';

import { DEGRADED_BY_STATUS } from './degradation';
import {
  InMemoryIntentCache,
  INTENT_CACHE_MAX_ENTRIES,
  intentCacheKey,
  type IntentCache,
} from './intent-cache';
import { lexicalIntent, parseIntentPayload } from './intent-schema';
import type { IntentParser, IntentParserResult } from './intent-parser';
import { buildIntentMessages, PROMPT_VERSION } from './prompt';

export interface OpenAiCompatOptions {
  /** Base do provedor, sem barra final; ex. `https://llm.test/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Chave da LLM; vive só aqui e no header (regra 4). */
  readonly apiKey?: string;
  /** Timeout em segundos (`LLM_TIMEOUT_S`). */
  readonly timeoutS: number;
}

const TEMPERATURE = 0.2;
const MAX_COMPLETION_TOKENS = 256;
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

/**
 * Teto do corpo aceito do provedor. O default do axios é `-1` (sem limite): um
 * upstream hostil ou quebrado poderia devolver gigabytes e derrubar o processo
 * por memória. Um `chat/completions` com `max_tokens: 256` não chega perto disto.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Corpo mínimo que sabemos ler de uma resposta `chat/completions`. */
interface CompletionBody {
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

/** Parser do provedor OpenAI-compatible, com cache de intenção embutido. */
export class OpenAICompatParser implements IntentParser {
  private readonly options: OpenAiCompatOptions;
  private readonly http: AxiosInstance;
  private readonly cache: IntentCache;
  private readonly logger = new Logger(OpenAICompatParser.name);

  /**
   * Construir **não** abre socket: o `AxiosInstance` só nasce com `baseURL` e
   * configuração. É o que permite `LlmModule` ser montado em teste sem rede.
   */
  constructor(
    options: OpenAiCompatOptions,
    cache: IntentCache = new InMemoryIntentCache({
      maxEntries: INTENT_CACHE_MAX_ENTRIES,
    }),
  ) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
    this.cache = cache;
    this.http = axios.create({
      baseURL: this.options.baseUrl,
      timeout: Math.max(1, Math.round(options.timeoutS * 1000)),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      // Sem teto de corpo e sem redirect: o provedor é um endpoint fixo, e um
      // 3xx que trocasse de origem levaria o header `authorization` junto.
      maxContentLength: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
    });
  }

  async parse(query: string, categories: readonly string[]): Promise<IntentParserResult> {
    const cacheKey = intentCacheKey({
      kind: 'intent',
      promptVersion: PROMPT_VERSION,
      model: this.options.model,
      query,
      categories,
    });

    const cached = this.cache.get(cacheKey);
    if (cached !== null) {
      // `cached` não degrada (tabela de §7.4), mas um hit de cache não pode
      // apagar a degradação que o resultado original carregava: uma intenção
      // `low_confidence` que voltasse como `cached` sairia com `degraded: false`
      // e a regra 7 falharia em silêncio na segunda busca idêntica.
      //
      // `model`/`tokens` voltam `null` porque **nesta** requisição não houve
      // chamada ao provedor (contrato de `search-response.dto.ts`): recontar os
      // tokens de uma chamada antiga a cada hit mentiria sobre o custo.
      return {
        intent: cached.intent,
        status: DEGRADED_BY_STATUS[cached.status] ? cached.status : 'cached',
        model: null,
        tokens: null,
      };
    }

    const result = await this.callProvider(query, categories);
    // Falha não é cacheada: a próxima busca deve poder tentar o provedor de novo.
    if (result.status !== 'unavailable') {
      this.cache.set(cacheKey, result);
    }
    return result;
  }

  private async callProvider(
    query: string,
    categories: readonly string[],
  ): Promise<IntentParserResult> {
    const body = {
      model: this.options.model,
      messages: buildIntentMessages(query, categories),
      temperature: TEMPERATURE,
      max_tokens: MAX_COMPLETION_TOKENS,
      // Sem tools: a LLM não executa nada, só devolve a intenção (§8.3).
      tools: [],
      tool_choice: 'none',
      response_format: { type: 'json_object' },
    } as const;

    try {
      const data = await this.postWithRetry(body);
      return this.toResult(data, query, categories);
    } catch (error) {
      // Só o motivo, nunca a mensagem: um 401 pode citá-la com a chave dentro.
      this.logger.debug(`intent call degraded: ${describeFailure(error)}`);
      return { intent: lexicalIntent(query), status: 'unavailable', model: null, tokens: null };
    }
  }

  private async postWithRetry(body: unknown): Promise<CompletionBody> {
    let retries = 0;
    for (;;) {
      try {
        const response = await this.http.post<CompletionBody>('/chat/completions', body, {
          headers: this.requestHeaders(),
        });
        return response.data;
      } catch (error) {
        if (retries >= MAX_RETRIES || !isRetryable(error)) {
          throw error;
        }
        retries += 1;
        await sleep(Math.min(RETRY_BACKOFF_MS * retries, MAX_BACKOFF_MS));
      }
    }
  }

  private requestHeaders(): Record<string, string> {
    return this.options.apiKey === undefined
      ? {}
      : { authorization: `Bearer ${this.options.apiKey}` };
  }

  private toResult(
    data: CompletionBody,
    query: string,
    categories: readonly string[],
  ): IntentParserResult {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { intent: lexicalIntent(query), status: 'unavailable', model: null, tokens: null };
    }
    const { intent, status } = parseIntentPayload(content, { query, categories });
    return {
      intent,
      status,
      model:
        typeof data.model === 'string' && data.model.length > 0 ? data.model : this.options.model,
      tokens: toTokenUsage(data.usage),
    };
  }
}

function toTokenUsage(usage: CompletionBody['usage']): TokenUsage | null {
  const prompt = usage?.prompt_tokens;
  const completion = usage?.completion_tokens;
  if (typeof prompt !== 'number' || typeof completion !== 'number') {
    return null;
  }
  return { prompt, completion };
}

/** Timeout é do usuário: retentar dobraria a espera sem chance de resposta melhor. */
function isTimeout(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT');
}

/** Rede (sem resposta), 429 e 5xx valem um retry; 4xx de contrato/key não vale. */
function isRetryable(error: unknown): boolean {
  if (!axios.isAxiosError(error) || isTimeout(error)) {
    return false;
  }
  const status = error.response?.status;
  if (status === undefined) {
    return true;
  }
  return status === 429 || status >= 500;
}

/** Descrição sem conteúdo sensível: código do axios ou HTTP status. */
function describeFailure(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.name : 'unknown';
  }
  if (error.response !== undefined) {
    return `http ${error.response.status}`;
  }
  return error.code ?? 'network';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
