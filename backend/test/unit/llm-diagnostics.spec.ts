/**
 * Fase 3 da auditoria de latência — a falha da LLM tem de ser diagnosticável.
 *
 * Fase 0 mediu o problema: com `LOG_LEVEL=info` a busca respondia
 * `llm.status="unavailable"` e **nenhuma linha** de log dizia por quê. O caminho de
 * falha (`openai-compat.ts`) logava em `debug` — invisível no nível que roda em
 * dev e em prod — e o caminho de **conteúdo vazio** (`choices[0].message.content`
 * vazio) não logava nada em nível nenhum.
 *
 * O contrato que este spec fixa:
 *
 *   - falha do provedor sai em `warn` com `{step, reason, httpStatus, errorCode,
 *     elapsedMs, timeoutMs, model}` — e **nunca** a chave nem o corpo da
 *     requisição/resposta (um 401 do provedor cita a chave na mensagem);
 *   - conteúdo vazio é falha nomeada (`reason: "empty_content"`), não silêncio;
 *   - `timeoutMs` no log é o teto **efetivo** da etapa: `LLM_TIMEOUT_S` só pode
 *     baixá-lo, nunca subir acima de 3000 ms na intenção e 4000 ms na explicação.
 */
import { Logger } from '@nestjs/common';
import nock from 'nock';

import { OpenAICompatParser } from '@/llm/openai-compat';
import type { OpenAiCompatOptions } from '@/llm/openai-compat';
import type { ExplainCandidate, ExplainRequest } from '@/llm/explain-parser';
import type { Intent } from '@/contract/dto/search-response.dto';

const ORIGIN = 'https://llm.test';
const CHAT_PATH = '/v1/chat/completions';
const MODEL = 'deepseek-v4.1-flash';
const QUERY = 'testing';
const CATEGORIES = ['security', 'dev', 'data', 'testing'] as const;

/** A chave do caso da aceitação: o provedor a repete no corpo do 401. */
const INVALID_KEY = 'sk-invalida';

const INTENT = {
  category: 'testing',
  keywords: ['testing'],
  filters: { exclude_with_vulnerabilities: false },
  language: 'en',
  confidence: 0.8,
} satisfies Intent;

const CANDIDATES: readonly ExplainCandidate[] = [
  {
    skill_id: 'sk_rank1',
    name: 'webapp-testing',
    category: 'testing',
    stars: 10,
    installs: 20,
    vulnerability_count: 0,
    summary: 'Tests a web app.',
  },
];

function explainRequest(): ExplainRequest {
  return { query: QUERY, intent: INTENT, candidates: CANDIDATES };
}

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function parser(overrides: Partial<OpenAiCompatOptions> = {}): OpenAICompatParser {
  return new OpenAICompatParser({
    baseUrl: `${ORIGIN}/v1`,
    model: MODEL,
    apiKey: INVALID_KEY,
    timeoutS: 8,
    ...overrides,
  });
}

/** Uma linha de log na forma em que o `nestjs-pino` a recebe: campos + mensagem. */
interface WarnLine {
  readonly fields: Record<string, unknown>;
  readonly message: unknown;
}

/** Captura o que o cliente escreve em `warn` — sem console no meio. */
function captureWarn(): WarnLine[] {
  const lines: WarnLine[] = [];
  jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((fields: unknown, message?: unknown) => {
      lines.push({
        fields:
          typeof fields === 'object' && fields !== null
            ? (fields as Record<string, unknown>)
            : { message: fields },
        message,
      });
    });
  return lines;
}

afterEach(() => {
  nock.cleanAll();
  jest.restoreAllMocks();
});

describe('diagnóstico da falha do provedor (Fase 3)', () => {
  it('um 401 vira warn com os campos do diagnóstico', async () => {
    const lines = captureWarn();
    // O provedor real repete a chave recebida na mensagem do 401 — é exatamente o
    // texto que não pode entrar no log (regra 4 do AGENTS.md).
    nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(401, { error: { message: `Incorrect API key provided: ${INVALID_KEY}` } });

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.fields).toMatchObject({
      step: 'intent',
      reason: 'http_error',
      httpStatus: 401,
      model: MODEL,
      // Teto efetivo da intenção: `min(LLM_TIMEOUT_S, INTENT_STEP_MAX_MS)`.
      timeoutMs: 3_000,
    });
    expect(typeof line?.fields.elapsedMs).toBe('number');
    // Só o motivo. Nem a chave, nem a mensagem do provedor.
    expect(JSON.stringify(lines)).not.toContain(INVALID_KEY);
    expect(JSON.stringify(lines)).not.toContain('Incorrect API key');
  });

  it('timeout é nomeado como timeout, e o teto logado é o efetivo', async () => {
    const lines = captureWarn();
    // `LLM_TIMEOUT_S = 0,2` baixa o teto da intenção de 3000 ms para 200 ms.
    nock(ORIGIN).post(CHAT_PATH).delayConnection(500).reply(200, completion(JSON.stringify(INTENT)));

    const result = await parser({ timeoutS: 0.2 }).parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      step: 'intent',
      reason: 'timeout',
      // `LLM_TIMEOUT_S` só baixa o teto: 200 ms, nunca os 3000 do default.
      timeoutMs: 200,
    });
  });

  it('conteúdo vazio é falha nomeada (empty_content), não silêncio', async () => {
    const lines = captureWarn();
    nock(ORIGIN).post(CHAT_PATH).reply(200, completion(''));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      step: 'intent',
      reason: 'empty_content',
      httpStatus: null,
      model: MODEL,
      timeoutMs: 3_000,
    });
  });

  it('a falha da explicação sai em warn com step=explain e o teto de 4000 ms', async () => {
    const lines = captureWarn();
    // 502 é retentável: o cliente tenta duas vezes (MAX_RETRIES=1) e então desiste.
    nock(ORIGIN).post(CHAT_PATH).times(2).reply(502, { error: { message: 'bad gateway' } });

    const result = await parser().explain(explainRequest());

    expect(result.status).toBe('unavailable');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      step: 'explain',
      reason: 'http_error',
      httpStatus: 502,
      model: MODEL,
      timeoutMs: 4_000,
    });
  });

  it('o caminho de sucesso não escreve warn', async () => {
    const lines = captureWarn();
    nock(ORIGIN).post(CHAT_PATH).reply(200, completion(JSON.stringify(INTENT)));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).not.toBe('unavailable');
    expect(lines).toEqual([]);
  });
});
