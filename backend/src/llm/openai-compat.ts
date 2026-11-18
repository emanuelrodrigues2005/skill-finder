/**
 * Cliente do provedor OpenAI-compatible (`docs/app/02-arquitetura.md` §6.3 e §8.3).
 *
 * Usa **axios** de propósito: o `nock` intercepta `http.request`, e o setup do
 * Jest roda com `nock.disableNetConnect()` (regra 5). Um cliente baseado em
 * `fetch` passaria por fora desse bloqueio e a suíte mentiria.
 *
 * Regras da chamada (as duas portas, intenção e explicação):
 *   - `POST {baseUrl}/chat/completions`, sem streaming e sem tools;
 *   - `temperature: 0.2`: a intenção é extração e a explicação é redação sobre
 *     dados já ranqueados — nenhuma das duas pede criatividade;
 *   - `max_tokens` fixo por etapa (256 na intenção, 768 na explicação): não varia
 *     com o tamanho da entrada;
 *   - `response_format: {type: 'json_object'}` (ADR-004);
 *   - retry de rede/429/5xx com ~250 ms de espera; timeout nunca é retentado (o
 *     usuário já esperou o suficiente);
 *   - **orçamento de latência** (F2.10): cada chamada recebe o menor entre o teto
 *     da etapa e o que sobrou de `LLM_TOTAL_DEADLINE_MS`; sem orçamento, o passo de
 *     explicação não é tentado (`explain_status: null`);
 *   - falha vira status degradado (`unavailable`), para a busca não morrer (§7.4).
 *
 * Nada de header, corpo ou chave em log — e a mensagem do provedor (que pode
 * citar a chave em um 401) nunca entra no resultado (regra 4).
 */
import { Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';

// Import de VALOR: caminho relativo, nunca `@/`.
//
// O alias `@/` (`tsconfig.json` → `paths`) só é resolvido pelo `tsc` e pelo Jest
// (`moduleNameMapper`). `ts-node` **não** o resolve em runtime, e
// `scripts/generate-openapi.ts` roda por ts-node: um import de valor via `@/`
// derruba o `openapi:generate` no CI com `MODULE_NOT_FOUND` (foi o que
// aconteceu na primeira execução da F2.10). Import `type` pode usar `@/`, porque
// o compilador o apaga.
import { DEFAULT_LLM_TOTAL_DEADLINE_MS } from '../config/env.schema';
import type { TokenUsage } from '@/contract/dto/search-response.dto';

import { DEGRADED_BY_STATUS } from './degradation';
import {
  EXPLAIN_MIN_BUDGET_MS,
  explainStepTimeoutMs,
  intentStepTimeoutMs,
  parseExplainPayload,
  remainingBudgetMs,
  skippedExplain,
  type ExplainParser,
  type ExplainRequest,
  type ExplainResult,
} from './explain-parser';
import {
  buildExplainMessages,
  buildExplainRepairMessages,
  EXPLAIN_PROMPT_VERSION,
} from './explain-prompt';
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
  /** Teto somado das chamadas numa busca (`LLM_TOTAL_DEADLINE_MS`); default 7000. */
  readonly totalDeadlineMs?: number;
  /** Relógio injetável; default `Date.now` — orçamento não pode depender disso no teste. */
  readonly now?: () => number;
}

const TEMPERATURE = 0.2;
const MAX_COMPLETION_TOKENS = 256;
const MAX_EXPLAIN_TOKENS = 768;
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;

/**
 * Piso para INICIAR uma tentativa. Abaixo disso nao vale comecar: o timeout
 * seria menor que a latencia tipica do provedor e o retry so gastaria o
 * orcamento que ja acabou.
 */
const MIN_ATTEMPT_MS = 250;

/**
 * Chave do cache de explicação (§6.3): `kind` próprio, a **versão do prompt** de
 * explicação e o conjunto ranqueado no slot de `candidate_ids` (é ele que
 * restringe a resposta). Mudar uma vírgula no prompt invalida o cache.
 */
export function explainCacheKey(
  request: ExplainRequest,
  model: string,
  promptVersion: string = EXPLAIN_PROMPT_VERSION,
): string {
  return intentCacheKey({
    kind: 'explain',
    promptVersion,
    model,
    query: request.query,
    categories: [],
    // Ordem crua, sem `.sort()`: a posição é parte da resposta (a recomendação é
    // o rank 1). Com o `sort` que `intentCacheKey` aplica a `categories`, duas
    // ordens diferentes acertavam a mesma prosa e a recomendação apontava para a
    // skill errada (achado HIGH do parecer da #41).
    candidates: request.candidates.map((candidate) => candidate.skill_id),
    // Números de catálogo mudam entre ciclos; sem o snapshot na chave o cache
    // serve prosa com valores vencidos.
    catalogSnapshot: request.catalog_snapshot,
  });
}

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
export class OpenAICompatParser implements IntentParser, ExplainParser {
  private readonly options: Required<Pick<OpenAiCompatOptions, 'totalDeadlineMs' | 'now'>> &
    OpenAiCompatOptions;
  private readonly http: AxiosInstance;
  private readonly cache: IntentCache;
  /** Cache da explicação: chave com `kind`, versão do prompt e conjunto ranqueado. */
  private readonly explainCache: IntentCache<ExplainResult> =
    new InMemoryIntentCache<ExplainResult>({ maxEntries: INTENT_CACHE_MAX_ENTRIES });
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
    this.options = {
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      totalDeadlineMs: options.totalDeadlineMs ?? DEFAULT_LLM_TOTAL_DEADLINE_MS,
      now: options.now ?? Date.now,
    };
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

  /**
   * Instante em que o orçamento total da busca expira.
   *
   * Quem monta a busca pode passar o `deadlineAtMs` calculado no começo dela; sem
   * isso, o orçamento começa a contar nesta chamada — o pior caso continua sendo
   * `LLM_TOTAL_DEADLINE_MS`, nunca a soma das duas etapas.
   */
  private deadlineAt(deadlineAtMs?: number): number {
    return deadlineAtMs ?? this.options.now() + this.options.totalDeadlineMs;
  }

  async parse(
    query: string,
    categories: readonly string[],
    budget: { readonly deadlineAtMs?: number } = {},
  ): Promise<IntentParserResult> {
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
        // Sem esta linha o hit do cache perdia os termos em inglês e o FTS
        // voltava a receber a consulta crua (em PT) contra um `search_doc` em
        // inglês: o defeito da #40 reaparecia na SEGUNDA busca idêntica, em
        // silêncio, porque `cached` não degrada.
        keywordsEn: cached.keywordsEn,
      };
    }

    // Um unico `deadlineAtMs` para a etapa: o retry de rede recalculava o restante
    // sem ele e o teto somado da busca virava ficcao (parecer da #41).
    const deadlineAtMs = this.deadlineAt(budget.deadlineAtMs);
    const remaining = remainingBudgetMs(deadlineAtMs, this.options.now());
    const result = await this.callProvider(query, categories, this.intentTimeout(remaining), deadlineAtMs);
    // Falha não é cacheada: a próxima busca deve poder tentar o provedor de novo.
    if (result.status !== 'unavailable') {
      this.cache.set(cacheKey, result);
    }
    return result;
  }

  /** Teto da chamada de intenção: o menor entre `LLM_TIMEOUT_S` e o orçamento. */
  private intentTimeout(remainingMs: number): number {
    const configured = Math.round(this.options.timeoutS * 1000);
    return Math.max(1, Math.min(configured, intentStepTimeoutMs(remainingMs)));
  }

  private async callProvider(
    query: string,
    categories: readonly string[],
    timeoutMs: number,
    deadlineAtMs?: number,
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
      const data = await this.postWithRetry(body, timeoutMs, deadlineAtMs);
      return this.toResult(data, query, categories);
    } catch (error) {
      // Só o motivo, nunca a mensagem: um 401 pode citá-la com a chave dentro.
      this.logger.debug(`intent call degraded: ${describeFailure(error)}`);
      return { intent: lexicalIntent(query), status: 'unavailable', model: null, tokens: null };
    }
  }

  /**
   * Passo de explicação (§6.5): um payload validado pela escada, ou o motivo da
   * rejeição — nunca texto do modelo direto para a resposta.
   *
   * Ordem: orçamento (menos de {@link EXPLAIN_MIN_BUDGET_MS} não tenta), cache,
   * primeira chamada, **um** reparo quando o problema é de id, e fallback. Falha
   * do provedor não é retentada aqui além do retry de rede do `postWithRetry`.
   */
  async explain(request: ExplainRequest): Promise<ExplainResult> {
    if (request.candidates.length === 0) {
      // Sem candidato não há o que explicar: `explain_status: null` (não tentado).
      return skippedExplain('no_candidates');
    }

    const deadlineAtMs = this.deadlineAt(request.deadlineAtMs);

    // O cache vem ANTES do portao de orcamento: um hit nao paga provedor nem
    // "tenta" nada, entao nega-lo por falta de tempo so custaria prosa pronta
    // numa segunda busca identica (achado LOW do parecer da #41).
    const cacheKey = explainCacheKey(request, this.options.model);
    const cached = this.explainCache.get(cacheKey);
    if (cached !== null) {
      // Hit de cache nao paga provedor: `model`/`tokens` voltam `null`, como no
      // passo de intencao. `repaired` sobrevive ao hit - sobrescrever sempre com
      // `cached` esconderia que a prosa precisou de conserto, o mesmo defeito
      // que a #40 corrigiu no passo de intencao.
      return {
        ...cached,
        status: cached.status === 'repaired' ? 'repaired' : 'cached',
        reason: null,
        model: null,
        tokens: null,
      };
    }

    const remaining = remainingBudgetMs(deadlineAtMs, this.options.now());
    if (remaining < EXPLAIN_MIN_BUDGET_MS) {
      return skippedExplain('budget');
    }

    try {
      const first = await this.explainOnce(request, explainStepTimeoutMs(remaining), false, deadlineAtMs);
      if (first.kind === 'payload') {
        this.explainCache.set(cacheKey, first.result);
        return first.result;
      }
      // Degrau 1 não tem reparo: corpo fora do schema é corpo que não dá para ler.
      if (first.reason !== 'invalid_ids') {
        return rejectedExplain(first.reason);
      }

      // Degrau 3: **um** reparo, e só se ainda houver orçamento para ele.
      const retryRemaining = remainingBudgetMs(deadlineAtMs, this.options.now());
      if (retryRemaining < EXPLAIN_MIN_BUDGET_MS) {
        return rejectedExplain('invalid_ids');
      }
      const repaired = await this.explainOnce(request, explainStepTimeoutMs(retryRemaining), true, deadlineAtMs);
      if (repaired.kind === 'payload') {
        this.explainCache.set(cacheKey, repaired.result);
        return repaired.result;
      }
      return rejectedExplain(repaired.reason);
    } catch (error) {
      this.logger.debug(`explain call degraded: ${describeFailure(error)}`);
      return {
        items: [],
        recommendation: null,
        status: 'unavailable',
        reason: isTimeout(error) ? 'timeout' : 'provider_error',
        model: null,
        tokens: null,
      };
    }
  }

  /** Uma chamada de explicação (ou do reparo), já validada pela escada. */
  private async explainOnce(
    request: ExplainRequest,
    timeoutMs: number,
    repair: boolean,
    deadlineAtMs: number,
  ): Promise<ExplainAttempt> {
    const body = {
      model: this.options.model,
      messages: repair ? buildExplainRepairMessages(request) : buildExplainMessages(request),
      temperature: TEMPERATURE,
      max_tokens: MAX_EXPLAIN_TOKENS,
      // Barreira 4 do §6.5: o provedor não executa nada — a saída dele é prosa.
      tools: [],
      tool_choice: 'none',
      response_format: { type: 'json_object' },
    } as const;

    const data = await this.postWithRetry(body, timeoutMs, deadlineAtMs);
    const content = firstContent(data);
    if (content === null) {
      return { kind: 'rejected', reason: 'invalid_json' };
    }

    const verdict = parseExplainPayload(content, { candidates: request.candidates });
    if (!verdict.ok) {
      return { kind: 'rejected', reason: verdict.reason };
    }
    return {
      kind: 'payload',
      result: {
        items: verdict.items,
        recommendation: verdict.recommendation,
        status: verdict.status,
        reason: null,
        model:
          typeof data.model === 'string' && data.model.length > 0 ? data.model : this.options.model,
        tokens: toTokenUsage(data.usage),
      },
    };
  }

  /**
   * `timeoutMs` e um TETO, nao uma parede: o prazo absoluto (`deadlineAtMs`)
   * manda. O retry de rede reusa o mesmo timeout sem recontar, entao o pior caso
   * de uma chamada era `t1 + backoff + t1` - com t1 = 4000 dentro de um orcamento
   * de 7000, a busca estourava o teto somado (achado MEDIUM do parecer da #41).
   * Aqui cada tentativa recalcula o restante e nao retenta sem tempo para terminar.
   */
  private async postWithRetry(
    body: unknown,
    timeoutMs: number,
    deadlineAtMs?: number,
  ): Promise<CompletionBody> {
    let retries = 0;
    for (;;) {
      const budgetLeft =
        deadlineAtMs === undefined
          ? Number.POSITIVE_INFINITY
          : remainingBudgetMs(deadlineAtMs, this.options.now());
      // Sem tempo para uma tentativa de tamanho util, falha agora em vez de
      // comecar uma chamada que nao tem como terminar dentro do prazo.
      if (budgetLeft < MIN_ATTEMPT_MS) {
        throw new Error("LLM deadline exhausted before the request started");
      }
      const attemptTimeout = Math.min(timeoutMs, budgetLeft);
      try {
        const response = await this.http.post<CompletionBody>('/chat/completions', body, {
          headers: this.requestHeaders(),
          // O orcamento manda: o timeout configurado e o teto, o restante e o real.
          timeout: attemptTimeout,
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
    const { intent, status, keywordsEn } = parseIntentPayload(content, { query, categories });
    return {
      intent,
      // Termos em inglês para o `tsquery` do `search_doc` (issue #40): viajam fora
      // da `Intent` para não tocar no contrato público.
      keywordsEn,
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

/** Resultado de uma tentativa de explicação: payload utilizável ou motivo da rejeição. */
type ExplainAttempt =
  | { readonly kind: 'payload'; readonly result: ExplainResult }
  | { readonly kind: 'rejected'; readonly reason: 'invalid_json' | 'invalid_ids' };

/**
 * Traduz a rejeição da escada para o contrato sem inventar status.
 *
 * `invalid_json` não existe em `LlmStatus` (§6.3, enum fechado): corpo fora do
 * schema é `unavailable`, o mesmo desfecho que o passo de intenção já dá a um
 * `IntentPayloadError`. O rótulo `invalid_json` segue no `reason`, que é onde a
 * métrica `llm_calls_total{status="invalid_json"}` o encontra.
 */
function rejectedExplain(reason: 'invalid_json' | 'invalid_ids'): ExplainResult {
  return {
    items: [],
    recommendation: null,
    status: reason === 'invalid_json' ? 'unavailable' : 'invalid_ids',
    reason,
    model: null,
    tokens: null,
  };
}

/** Conteúdo de `choices[0].message.content`, ou `null` quando não há texto. */
function firstContent(data: CompletionBody): string | null {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim().length > 0 ? content : null;
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
