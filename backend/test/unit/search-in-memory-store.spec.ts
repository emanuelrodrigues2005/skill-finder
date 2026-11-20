/**
 * Issue #12 — o duplo em memória da porta `SearchStore`
 * (`backend/src/search/in-memory-search-store.ts`), hoje com 0% de cobertura.
 *
 * O que o duplo promete e este spec fixa:
 *
 * - **cópias defensivas** nos dois sentidos: mutar o registro depois de `save`
 *   (ou mutar a linha devolvida) não muda o que está guardado. Sem isso, um
 *   teste que reusa o objeto de entrada vê outro histórico;
 * - `search_id` cunhado pelo armazenamento (`randomUUID`), com a forma da coluna
 *   `uuid` — o `PrismaSearchStoreRepository` faz o mesmo pelo banco;
 * - a projeção `toJSON` é **JSON-safe** (`result_ids` é `BIGINT[]` e
 *   `JSON.stringify` de `bigint` lança) e **não** carrega `query_text` (§8.5:
 *   texto de consulta não vai para log nem auditoria).
 */
import type { Intent } from '@/contract/dto/search-response.dto';
import { InMemorySearchStore } from '@/search/in-memory-search-store';
import type { StoredSearchFields } from '@/search/search-store.port';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    category: 'backend',
    keywords: ['python', 'security'],
    filters: { exclude_with_vulnerabilities: true },
    language: 'en',
    confidence: 0.82,
    ...overrides,
  };
}

/** O que a busca entrega ao armazenamento; `toJSON` é obrigatório na porta. */
function record(overrides: Partial<StoredSearchFields> = {}): StoredSearchFields {
  return {
    request_id: 'req_01JCV8Y6Q4NAOEXISTE0000000',
    created_at: new Date('2026-11-17T12:00:00.000Z'),
    client_hash: 'a'.repeat(64),
    query_hash: 'b'.repeat(64),
    query_text: null,
    intent: intent(),
    category_slug: 'backend',
    result_ids: [7n, 9n],
    candidates_count: 2,
    llm_status: 'ok',
    degraded: false,
    latency_ms: 12,
    status: 'ok',
    ...overrides,
  };
}

describe('InMemorySearchStore — save e findByRequestId', () => {
  it('stores the row under its request_id and mints a uuid search_id', async () => {
    const store = new InMemorySearchStore();
    const input = record();

    const saved = await store.save({ ...input, toJSON: () => input });

    expect(saved.request_id).toBe(input.request_id);
    expect(saved.search_id).toMatch(UUID);
    expect(saved.query_hash).toBe(input.query_hash);
    expect(saved.result_ids).toEqual([7n, 9n]);
    expect(saved.created_at).toEqual(input.created_at);

    const found = await store.findByRequestId(input.request_id);
    expect(found).not.toBeNull();
    expect(found?.search_id).toBe(saved.search_id);
  });

  it('answers null for a request_id that was never saved', async () => {
    const store = new InMemorySearchStore();

    expect(await store.findByRequestId('req_01JCV8Y6Q4DESCONHECIDO00')).toBeNull();
  });

  it('mints a different search_id per save and keeps both rows', async () => {
    const store = new InMemorySearchStore();

    const first = await store.save({ ...record({ request_id: 'req_01JCV8Y6Q4AAA0000000' }), toJSON: () => ({}) });
    const second = await store.save({ ...record({ request_id: 'req_01JCV8Y6Q4BBB0000000' }), toJSON: () => ({}) });

    expect(first.search_id).not.toBe(second.search_id);
    expect((await store.findByRequestId(first.request_id))?.search_id).toBe(first.search_id);
    expect((await store.findByRequestId(second.request_id))?.search_id).toBe(second.search_id);
  });

  it('replaces the row when the same request_id is saved twice', async () => {
    // A chave do `Map` é o `request_id`, como a `UNIQUE` da coluna no banco.
    const store = new InMemorySearchStore();

    await store.save({ ...record({ result_ids: [1n] }), toJSON: () => ({}) });
    const replaced = await store.save({ ...record({ result_ids: [2n, 3n] }), toJSON: () => ({}) });

    expect((await store.findByRequestId(record().request_id))?.result_ids).toEqual([2n, 3n]);
    expect(replaced.result_ids).toEqual([2n, 3n]);
  });
});

describe('InMemorySearchStore — cópia defensiva na entrada', () => {
  it('does not follow mutations of the record after save', async () => {
    const store = new InMemorySearchStore();
    const input = record();
    await store.save({ ...input, toJSON: () => input });

    // O chamador reusa o objeto (a busca monta o registro uma vez e segue).
    input.intent.keywords.push('mutado');
    input.intent.filters.exclude_with_vulnerabilities = false;
    input.result_ids.push(99n);

    const found = await store.findByRequestId(input.request_id);
    expect(found?.intent.keywords).toEqual(['python', 'security']);
    expect(found?.intent.filters.exclude_with_vulnerabilities).toBe(true);
    expect(found?.result_ids).toEqual([7n, 9n]);
  });

  it('copies the intent and the id list, not the references', async () => {
    const store = new InMemorySearchStore();
    const shared = record();
    await store.save({ ...shared, toJSON: () => ({}) });
    await store.save({
      ...shared,
      request_id: 'req_01JCV8Y6Q4OUTRA000000',
      toJSON: () => ({}),
    });

    shared.result_ids.push(42n);

    // Dois registros que compartilham o objeto de entrada continuam independentes
    // do que o chamador faz depois — e um do outro.
    expect((await store.findByRequestId(shared.request_id))?.result_ids).toEqual([7n, 9n]);
    expect((await store.findByRequestId('req_01JCV8Y6Q4OUTRA000000'))?.result_ids).toEqual([
      7n, 9n,
    ]);
  });
});

describe('InMemorySearchStore — projeção JSON (§8.5 e `BIGINT[]`)', () => {
  it('serializes bigint ids as decimal strings and never throws', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save({ ...record(), toJSON: () => ({}) });

    // `JSON.stringify` de `bigint` lança: é o defeito que a projeção evita.
    expect(() => JSON.stringify(saved)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;

    expect(parsed.search_id).toBe(saved.search_id);
    expect(parsed.request_id).toBe(saved.request_id);
    expect(parsed.result_ids).toEqual(['7', '9']);
    expect(parsed.status).toBe('ok');
  });

  it('keeps the query text out of the projection even when it was stored', async () => {
    const store = new InMemorySearchStore();
    const saved = await store.save({
      ...record({ query_text: 'review pull requests for security' }),
      toJSON: () => ({}),
    });

    const parsed = JSON.parse(JSON.stringify(saved)) as Record<string, unknown>;

    // Gravado para auditoria interna (§8.5), nunca projetado em log.
    expect(saved.query_text).toBe('review pull requests for security');
    expect(parsed).not.toHaveProperty('query_text');
  });
});
