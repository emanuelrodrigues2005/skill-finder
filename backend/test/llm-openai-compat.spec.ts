/**
 * Issue #9 (F2.5) — cliente real OpenAI-compatible, exercitado com `nock`.
 *
 * Contrato exigido do codigo de producao (`backend/src/llm/openai-compat.ts`):
 *
 *   export interface OpenAiCompatOptions {
 *     baseUrl: string;    // sem barra final; ex. https://llm.test/v1
 *     model: string;
 *     apiKey?: string;
 *     timeoutS: number;   // LLM_TIMEOUT_S, em segundos
 *   }
 *   export class OpenAICompatParser implements IntentParser {
 *     constructor(options: OpenAiCompatOptions);   // construir NAO abre socket
 *   }
 *
 * Regras ratificadas:
 *   - `POST {baseUrl}/chat/completions`, `tools: []`, `tool_choice: 'none'`, `max_tokens <= 256`,
 *     `response_format.type === 'json_object'` (ADR-004, §8.3, Q2 ainda aberta para json_schema);
 *   - timeout de `timeoutS` segundos, 1 retry com backoff em 502/504, timeout NUNCA e retentado;
 *   - corpo nao-JSON, JSON fora do schema e erro do provedor -> `unavailable` + `Intent` lexical,
 *     para a busca nao morrer (§7.4);
 *   - a api key nunca sai no resultado nem no corpo persistido (§8.1).
 *
 * `nock` intercepta `http.request` (axios): este spec prova que o cliente e axios, nao `fetch`.
 */
import axios from 'axios';
import nock from 'nock';

import { OpenAICompatParser } from '@/llm/openai-compat';
import type { OpenAiCompatOptions } from '@/llm/openai-compat';

const ORIGIN = 'https://llm.test';
const CHAT_PATH = '/v1/chat/completions';
const MODEL = 'deepseek-v4.1-flash';
const API_KEY = 'sk-test-not-a-real-key';
const QUERY = 'review python pull requests for security issues';
const CATEGORIES = ['security', 'dev', 'data', 'testing'] as const;

const VALID_CONTENT = JSON.stringify({
  category: 'security',
  keywords: ['pull request', 'security', 'python'],
  filters: { exclude_with_vulnerabilities: true },
  language: 'en',
  confidence: 0.82,
});

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: MODEL,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  };
}

function parser(overrides: Partial<OpenAiCompatOptions> = {}): OpenAICompatParser {
  return new OpenAICompatParser({
    baseUrl: `${ORIGIN}/v1`,
    model: MODEL,
    apiKey: API_KEY,
    timeoutS: 8,
    ...overrides,
  });
}

afterEach(() => {
  nock.cleanAll();
});

describe('openai-compatible client (docs/app/02-arquitetura.md 6.3 e 8.3)', () => {
  it('posts the pinned body', async () => {
    let posted: Record<string, unknown> = {};
    const scope = nock(ORIGIN)
      .matchHeader('authorization', `Bearer ${API_KEY}`)
      .post(CHAT_PATH, (body: Record<string, unknown>) => {
        posted = body;
        return true;
      })
      .reply(200, completion(VALID_CONTENT));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(scope.isDone()).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.intent.category).toBe('security');
    expect(result.model).toBe(MODEL);
    expect(result.tokens).toEqual({ prompt: 120, completion: 45 });

    expect(posted.model).toBe(MODEL);
    expect(posted.tools).toEqual([]);
    expect(posted.tool_choice).toBe('none');
    expect((posted.response_format as { type?: string }).type).toBe('json_object');
    const maxTokens = posted.max_tokens as number;
    expect(maxTokens).toBeGreaterThan(0);
    expect(maxTokens).toBeLessThanOrEqual(256);

    const messages = posted.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[messages.length - 1].role).toBe('user');
    expect(messages[messages.length - 1].content).toContain(QUERY);
    expect(messages[messages.length - 1].content).toMatch(/<user_query>[\s\S]*<\/user_query>/);

    // Regra 4: a chave vive no cliente HTTP, nunca no resultado.
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('is intercepted by nock at all', async () => {
    // Prova que a regra 5 morde: `nock.disableNetConnect()` esta ativo no setup do Jest.
    await expect(axios.get('https://not-intercepted.example/v1/models')).rejects.toThrow(
      /Nock: Disallowed net connect/,
    );
  });

  it('returns unavailable on non-JSON body', async () => {
    nock(ORIGIN).post(CHAT_PATH).reply(200, completion('Sure! Here is the JSON you asked for.'));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    // Fallback lexical: a busca continua com a intencao tirada da propria query.
    expect(result.intent.category).toBeNull();
    expect(result.intent.keywords.length).toBeGreaterThan(0);
    for (const keyword of result.intent.keywords) {
      expect(QUERY.toLowerCase()).toContain(keyword.toLowerCase());
    }
  });

  it('returns unavailable on schema violation', async () => {
    const violation = JSON.stringify({
      category: null,
      keywords: 'not-an-array',
      filters: {},
      language: 'en',
      confidence: 0.9,
    });
    nock(ORIGIN).post(CHAT_PATH).reply(200, completion(violation));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(Array.isArray(result.intent.keywords)).toBe(true);
    expect(result.intent.keywords.length).toBeGreaterThan(0);
  });

  it('aborts at LLM_TIMEOUT_S and never retries a timeout', async () => {
    nock(ORIGIN).post(CHAT_PATH).once().delayConnection(3000).reply(200, completion(VALID_CONTENT));
    // Se o timeout fosse retentado, esta segunda resposta devolveria `ok`.
    const retry = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));

    const started = Date.now();
    const result = await parser({ timeoutS: 1 }).parse(QUERY, CATEGORIES);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500);
    expect(result.status).toBe('unavailable');
    expect(retry.isDone()).toBe(false);
  });

  it('retries once on 502 then succeeds', async () => {
    nock(ORIGIN).post(CHAT_PATH).once().reply(502, { error: { message: 'bad gateway' } });
    const success = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('ok');
    expect(result.intent.category).toBe('security');
    expect(success.isDone()).toBe(true);
  });

  it('gives up after one retry', async () => {
    nock(ORIGIN).post(CHAT_PATH).times(2).reply(502, { error: { message: 'bad gateway' } });
    // Uma terceira tentativa encontraria esta resposta e devolveria `ok`: o teste falharia.
    const third = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(third.isDone()).toBe(false);
  });

  it('maps 401 without echoing the key', async () => {
    nock(ORIGIN)
      .post(CHAT_PATH)
      .reply(401, { error: { message: `Incorrect API key provided: ${API_KEY}` } });

    const result = await parser().parse(QUERY, CATEGORIES);

    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain('Incorrect API key provided');
  });
});
