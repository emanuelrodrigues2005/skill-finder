/**
 * Issue #9 (F2.5) — cache do passo de intencao: repetir a mesma busca nao paga outra chamada.
 *
 * O cache vive no cliente (`backend/src/llm/openai-compat.ts`), chaveado por query + categorias:
 * a segunda chamada identica devolve `status: 'cached'` (tabela do architect: `cached` NAO
 * degrada) sem tocar a rede.
 */
import nock from 'nock';

import { resolveDegradation } from '@/llm/degradation';
import { OpenAICompatParser } from '@/llm/openai-compat';

const ORIGIN = 'https://llm.test';
const CHAT_PATH = '/v1/chat/completions';
const MODEL = 'deepseek-v4.1-flash';
const QUERY = 'review python pull requests for security issues';
const CATEGORIES = ['security', 'dev', 'data', 'testing'] as const;

const VALID_CONTENT = JSON.stringify({
  category: 'security',
  keywords: ['pull request', 'security', 'python'],
  filters: { exclude_with_vulnerabilities: true },
  language: 'en',
  confidence: 0.82,
});

/** Mesma intencao, confianca abaixo de `MIN_CONFIDENCE`: o passo sai `low_confidence`. */
const LOW_CONFIDENCE_CONTENT = JSON.stringify({
  category: 'security',
  keywords: ['pull request', 'security', 'python'],
  filters: { exclude_with_vulnerabilities: true },
  language: 'en',
  confidence: 0.2,
});

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 },
  };
}

function parser(): OpenAICompatParser {
  return new OpenAICompatParser({
    baseUrl: `${ORIGIN}/v1`,
    model: MODEL,
    apiKey: 'sk-test-not-a-real-key',
    timeoutS: 8,
  });
}

afterEach(() => {
  nock.cleanAll();
});

describe('intent cache', () => {
  it('a second identical parse is cached', async () => {
    // Um unico interceptor: uma segunda requisicao cairia em "no match" e viraria `unavailable`.
    const scope = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));
    const client = parser();

    const first = await client.parse(QUERY, CATEGORIES);
    const second = await client.parse(QUERY, CATEGORIES);

    expect(first.status).toBe('ok');
    expect(second.status).toBe('cached');
    expect(second.intent).toEqual(first.intent);
    // `keywordsEn` PRECISA sobreviver ao hit do cache. Sem isto o FTS da segunda
    // busca idêntica volta a receber a consulta crua (em PT) contra um
    // `search_doc` em inglês — o defeito da #40 reaparecendo em silêncio, porque
    // `cached` não degrada e nenhum outro teste olha este campo.
    expect(second.keywordsEn).toEqual(first.keywordsEn);
    expect(second.keywordsEn?.length ?? 0).toBeGreaterThan(0);
    expect(scope.isDone()).toBe(true);
  });

  it('does not answer a different query from the cache', async () => {
    const scope = nock(ORIGIN).post(CHAT_PATH).twice().reply(200, completion(VALID_CONTENT));
    const client = parser();

    const first = await client.parse(QUERY, CATEGORIES);
    const other = await client.parse('terraform plan for an aws account', CATEGORIES);

    expect(first.status).toBe('ok');
    expect(other.status).toBe('ok');
    expect(scope.isDone()).toBe(true);
  });

  /**
   * F2 do parecer de `security` na issue #9: o hit de cache trocava o status por
   * `cached` em qualquer caso. Como `cached` nao degrada e `low_confidence`
   * degrada, a segunda busca identica de uma intencao duvidosa saia com
   * `degraded: false` — a regra 7 falhando em silencio.
   */
  it('keeps the degraded status on a cache hit', async () => {
    // Um unico interceptor: a segunda chamada tem de vir do cache, nao da rede.
    const scope = nock(ORIGIN)
      .post(CHAT_PATH)
      .once()
      .reply(200, completion(LOW_CONFIDENCE_CONTENT));
    const client = parser();

    const first = await client.parse(QUERY, CATEGORIES);
    const second = await client.parse(QUERY, CATEGORIES);

    expect(first.status).toBe('low_confidence');
    expect(resolveDegradation(first.status).degraded).toBe(true);

    // Veio do cache mesmo (uma requisicao so)...
    expect(scope.isDone()).toBe(true);
    expect(second.intent).toEqual(first.intent);
    // `tokens` do hit e `null`: nesta requisicao nao houve chamada ao provedor e
    // recontar os da chamada antiga mentiria sobre o custo. `model` NAO segue essa
    // regra: um hit de cache nao pode esconder qual modelo produziu a intencao.
    expect(first.model).toBe(MODEL);
    expect(first.tokens).toEqual({ prompt: 120, completion: 45 });
    expect(second.model).toBe(MODEL);
    expect(second.tokens).toBeNull();
    // ...e a degradacao sobreviveu ao hit.
    expect(second.status).toBe('low_confidence');
    expect(second.status).not.toBe('cached');
    const degradation = resolveDegradation(second.status);
    expect(degradation.degraded).toBe(true);
    expect(degradation.degraded_reason).toBe('llm_unavailable');
  });

  /**
   * Defeito medido em 2026-11-25: duas buscas iguais respondiam `llm.model: null`
   * na segunda, porque o hit do cache zerava o campo. O `model` e o que explica
   * qual provedor produziu a intencao — esconder isto no hit e o mesmo defeito
   * da regra 7 (degradacao invisivel), so que na procedencia do dado.
   */
  it('reports the model that produced the intent on a cache hit', async () => {
    // Um unico interceptor: a segunda chamada tem de vir do cache.
    const scope = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));
    const client = parser();

    const first = await client.parse(QUERY, CATEGORIES);
    const second = await client.parse(QUERY, CATEGORIES);

    expect(first.model).toBe(MODEL);
    expect(scope.isDone()).toBe(true);
    expect(second.status).toBe('cached');
    expect(second.model).toBe(MODEL);
    // Tokens continuam nao atribuidos ao hit: so o modelo e procedencia.
    expect(second.tokens).toBeNull();
  });

  /** Controle: intencao saudavel continua virando `cached` (e nao degrada). */
  it('still marks a healthy cache hit as cached', async () => {
    const scope = nock(ORIGIN).post(CHAT_PATH).once().reply(200, completion(VALID_CONTENT));
    const client = parser();

    const first = await client.parse(QUERY, CATEGORIES);
    const second = await client.parse(QUERY, CATEGORIES);

    expect(first.status).toBe('ok');
    expect(second.status).toBe('cached');
    expect(resolveDegradation(second.status).degraded).toBe(false);
    expect(scope.isDone()).toBe(true);
  });
});
