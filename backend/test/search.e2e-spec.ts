/**
 * Issue #10 (F2.6) — os cinco endpoints públicos de §5.1 sobre HTTP.
 *
 * Sobe o `AppModule` de runtime (como `health.e2e-spec.ts`) e troca **só as
 * portas** por dublês: `SEARCH_CATALOG`, `SEARCH_STORE` e `PrismaService`. O
 * adaptador Postgres e o provedor de LLM nunca entram no caminho, então nenhum
 * socket é aberto (`nock.disableNetConnect()` no `test/setup.ts` continua
 * valendo).
 *
 * Decisões ratificadas que estes casos fixam: D-A (categoria inexistente é
 * `422 VALIDATION_ERROR` com `details.reason === 'UNKNOWN_CATEGORY'`), D-B
 * (`skill_id` no formato `sk_` + 20 chars), D-D (permalink é replay da busca
 * gravada, com `llm.cached === true` e `model`/`tokens` nulos), D-E (os cinco
 * públicos respondem; os dois de admin continuam 404, provados em
 * `health.e2e-spec.ts`), D-F (`llm_calls_total{status}`) e C4 (o
 * `X-Request-ID` forjado **nunca** vira o `request_id` da resposta).
 *
 * O `LLM_ENABLED=false` é o modo degradado de dev/CI (regra 5 do AGENTS.md): a
 * intenção sai do fallback lexical e a resposta é `degraded: true`, que é o
 * estado exercitado aqui. É também o que faz `llm_calls_total{status="disabled"}`
 * aparecer em `/metrics`.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import type { ResultItem } from '@/contract/dto/result-item.dto';
import type { SearchResponse } from '@/contract/dto/search-response.dto';
import { configureApp } from '@/main';
import { decodeSkillId, encodeSkillId } from '@/search/ids';
import type { SearchCatalog } from '@/search/search-catalog.port';
import type { SearchStore, StoredSearchInput, StoredSearchRow } from '@/search/search-store.port';
import { SEARCH_CATALOG, SEARCH_STORE } from '@/search/search.tokens';

// Configuração de teste documentada em `test/setup.ts`; forçada aqui porque o
// `test:e2e` roda com `--runInBand` e um `.env` local não pode mudar o cenário.
process.env.LLM_ENABLED = 'false';
process.env.SEARCH_LOG_STORE_TEXT = 'false';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** RFC 3339 UTC — o formato que `data.catalog_snapshot` promete (§5.3). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SKILL_ID = /^sk_[a-z0-9]{20}$/;
const REQUEST_ID = /^req_[0-9A-Z]{26}$/;

const OK_QUERY = 'review pull requests for security problems in Python';

const SKILL_A: SkillSummary = {
  skill_id: encodeSkillId(42n),
  name: 'python-security-review',
  source_url: 'https://skills.sh/example/python-security-review',
  category: 'backend',
  stars: 1200,
  installs: 8000,
  vulnerability_count: 0,
  security_status: 'ok',
  skill_md_present: true,
};

const SKILL_B: SkillSummary = {
  skill_id: encodeSkillId(43n),
  name: 'pr-hygiene',
  source_url: 'https://skills.sh/example/pr-hygiene',
  category: 'backend',
  stars: 300,
  installs: 2000,
  vulnerability_count: 1,
  security_status: 'warn',
  skill_md_present: false,
};

const SKILL_C: SkillSummary = {
  skill_id: encodeSkillId(44n),
  name: 'test-plan-author',
  source_url: null,
  category: 'testing',
  stars: null,
  installs: null,
  vulnerability_count: null,
  security_status: 'unknown',
  skill_md_present: false,
};

/** Skill só de detalhe: todos os campos opcionais ausentes (`n/a`, nunca 0). */
const SKILL_NULLS_ID = 45n;
const SKILL_NULLS: SkillDetail = {
  skill_id: encodeSkillId(SKILL_NULLS_ID),
  name: 'sparse-evidence-skill',
  source_url: null,
  category: null,
  stars: null,
  installs: null,
  vulnerability_count: null,
  security_status: 'unknown',
  skill_md_present: false,
  summary: null,
  repo_url: null,
  skill_md_excerpt: null,
};

const CATEGORIES: readonly CategoryItem[] = [
  { slug: 'backend', label_en: 'Backend', skill_count: 2 },
  { slug: 'testing', label_en: 'Testing', skill_count: 1 },
];

function freshSnapshot(): Date {
  return new Date(Date.now() - HOUR_MS);
}

/**
 * Porta do catálogo em memória. `SkillSummary.skill_id` já sai no formato
 * público; `findByIds`/`detail` falam a língua do banco (`bigint`), como o
 * adaptador Postgres fará.
 */
class CatalogStub implements SearchCatalog {
  snapshotAt: Date | null = freshSnapshot();
  skills: readonly SkillSummary[] = [SKILL_A, SKILL_B, SKILL_C];
  readonly categories: readonly CategoryItem[] = CATEGORIES;
  readonly details = new Map<bigint, SkillDetail>([[SKILL_NULLS_ID, SKILL_NULLS]]);

  search(): Promise<readonly SkillSummary[]> {
    return Promise.resolve(this.skills);
  }

  findByIds(ids: readonly bigint[]): Promise<readonly SkillSummary[]> {
    return Promise.resolve(
      this.skills.filter((item) => {
        const id = decodeSkillId(item.skill_id);
        return id !== null && ids.includes(id);
      }),
    );
  }

  detail(skillId: bigint): Promise<SkillDetail | null> {
    return Promise.resolve(this.details.get(skillId) ?? null);
  }

  snapshot(): Promise<Date | null> {
    return Promise.resolve(this.snapshotAt);
  }

  categoryExists(slug: string): Promise<boolean> {
    return Promise.resolve(this.categories.some((category) => category.slug === slug));
  }

  listCategories(): Promise<readonly CategoryItem[]> {
    return Promise.resolve(this.categories);
  }

  listSkills(): Promise<{ items: readonly SkillSummary[]; total_items: number }> {
    return Promise.resolve({ items: this.skills, total_items: this.skills.length });
  }
}

class StoreStub implements SearchStore {
  readonly saved: StoredSearchInput[] = [];
  rows: StoredSearchRow[] = [];
  readonly searchId = 'b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11';

  save(record: StoredSearchInput): Promise<StoredSearchRow> {
    this.saved.push(record);
    const row: StoredSearchRow = { ...record, search_id: this.searchId };
    this.rows.unshift(row);
    return Promise.resolve(row);
  }

  findByRequestId(requestId: string): Promise<StoredSearchRow | null> {
    return Promise.resolve(this.rows.find((row) => row.request_id === requestId) ?? null);
  }

  reset(): void {
    this.saved.length = 0;
    this.rows = [];
  }
}

class PrismaStub {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error('lista vazia');
  }
  return item;
}

describe('search endpoints (e2e)', () => {
  let app: INestApplication;
  let catalog: CatalogStub;
  let store: StoreStub;

  beforeAll(async () => {
    catalog = new CatalogStub();
    store = new StoreStub();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaStub())
      .overrideProvider(SEARCH_CATALOG)
      .useValue(catalog)
      .overrideProvider(SEARCH_STORE)
      .useValue(store)
      .compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    catalog.snapshotAt = freshSnapshot();
    catalog.skills = [SKILL_A, SKILL_B, SKILL_C];
    store.reset();
  });

  function postSearch(body: unknown): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/search')
      .send(body as object);
  }

  function get(path: string): request.Test {
    return request(app.getHttpServer()).get(path);
  }

  /**
   * Issue #10 (revisão): `source_stale` é do frescor do snapshot, não da
   * degradação. `LLM_ENABLED=false` degrada toda busca (`llm_unavailable`), e o
   * snapshot fresco não é catálogo velho — nem na busca, nem no permalink.
   */
  it('does not warn source_stale for a fresh snapshot, even with the LLM disabled', async () => {
    const response = await postSearch({ query: OK_QUERY }).expect(200);

    expect(response.body.data.age_seconds).toBeLessThan(6 * 3600);
    expect(response.body.data.degraded).toBe(true);
    expect(response.body.data.degraded_reason).toBe('llm_unavailable');
    expect(response.body.warnings).not.toContain('source_stale');
    expect(response.body.warnings).toContain('explanation_from_template');
  });

  it('warns source_stale on the replay only when the snapshot is stale', async () => {
    const created = await postSearch({ query: OK_QUERY }).expect(200);
    const requestId = created.body.request_id as string;

    const fresh = await get(`/api/v1/searches/${requestId}`).expect(200);
    expect(fresh.body.warnings).not.toContain('source_stale');
    // A degradação gravada (`llm_unavailable`) continua visível no replay; o que
    // não pode aparecer é "catálogo velho" com snapshot fresco.
    expect(fresh.body.data.degraded_reason).toBe('llm_unavailable');

    catalog.snapshotAt = new Date(Date.now() - 7 * HOUR_MS);
    const stale = await get(`/api/v1/searches/${requestId}`).expect(200);
    expect(stale.body.warnings).toContain('source_stale');
    expect(stale.body.data.degraded_reason).toBe('source_stale');
    expect(stale.body.data.age_seconds).toBeGreaterThanOrEqual(7 * 3600 - 60);
  });

  it('rejects an out-of-range page with 422 instead of a 500 from the offset (issue #10)', async () => {
    // `Number('9'.repeat(400))` é Infinity: sem teto, o offset infinito vira 500.
    for (const page of ['999999999999999999999', '9'.repeat(400), '10001']) {
      const response = await get(`/api/v1/skills?page=${page}`).expect(422);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.fields).toContain('page');
      expect(response.body.request_id).toMatch(/^req_/);
    }

    // Contrapositivo: o teto e a primeira página continuam válidos.
    const atCeiling = await get('/api/v1/skills?page=10000').expect(200);
    expect(atCeiling.body.pagination.page).toBe(10000);
    const firstPage = await get('/api/v1/skills?page=1').expect(200);
    expect(firstPage.body.pagination.page).toBe(1);
  });

  it('rejects a category longer than 64 characters without echoing it (issue #10)', async () => {
    const tooLong = 'a'.repeat(65);

    const rejected = await postSearch({ query: OK_QUERY, category: tooLong }).expect(422);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(rejected.body.error.details.fields).toContain('category');
    // O valor rejeitado não volta no corpo: sem amplificação por `error.message`.
    expect(JSON.stringify(rejected.body)).not.toContain(tooLong);

    // Contrapositivo: 64 cabe no teto do slug e chega à checagem do catálogo
    // (desconhecida => UNKNOWN_CATEGORY, não erro de validação de tamanho).
    const atLimit = await postSearch({ query: OK_QUERY, category: 'b'.repeat(64) }).expect(422);
    expect(atLimit.body.error.details.reason).toBe('UNKNOWN_CATEGORY');

    // E uma categoria existente continua aceita.
    const known = await postSearch({ query: OK_QUERY, category: 'backend' }).expect(200);
    expect(known.body.data.degraded_reason).toBe('llm_unavailable');
  });

  it('rejects a query of 501 characters as 422 without echoing it (issue #13)', async () => {
    const tooLong = 'a'.repeat(501);

    const rejected = await postSearch({ query: tooLong }).expect(422);
    expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    expect(rejected.body.error.details.fields).toContain('query');
    // Sem amplificação: o texto rejeitado não volta dentro do envelope.
    expect(JSON.stringify(rejected.body)).not.toContain(tooLong);
    expect(store.saved).toHaveLength(0);

    // Contrapositivo: exatamente 500 cabe no `@MaxLength(500)` e é buscado.
    const atLimit = await postSearch({ query: 'a'.repeat(500) }).expect(200);
    expect(atLimit.body.request_id).toMatch(/^req_/);
    expect(atLimit.body.results).toHaveLength(3);
    expect(store.saved).toHaveLength(1);
  });

  it('POST /api/v1/search ranks, explains and stamps the catalog snapshot', async () => {
    const response = await postSearch({ query: OK_QUERY, limit: 5 }).expect(200);
    const body = response.body as SearchResponse;

    expect(body.request_id).toMatch(REQUEST_ID);
    expect(typeof body.search_id).toBe('string');
    expect(body.search_id.length).toBeGreaterThan(0);
    expect(body.results).toHaveLength(3);

    const scores = body.results.map((item) => item.score);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
    expect(body.results.map((item) => item.rank)).toEqual([1, 2, 3]);

    for (const item of body.results) {
      expect(item.skill.skill_id).toMatch(SKILL_ID);
      expect(item.explanation.trim().length).toBeGreaterThan(0);
      expect(item.explanation.length).toBeLessThanOrEqual(1200);
      expect(item.explanation).not.toContain('{{');
      expect(Object.keys(item.score_breakdown).sort()).toEqual([
        'installs',
        'missing_fields',
        'penalty_factor',
        'stars',
        'vulnerabilities',
      ]);
      expect(item.evidence_completeness.missing_fields).toBeGreaterThanOrEqual(0);
    }

    expect(body.recommendation?.skill_id).toBe(body.results[0]?.skill.skill_id);
    expect(body.data.source).toBe('cache');
    expect(body.data.catalog_snapshot).toMatch(RFC3339);
    // Mesmo instante do snapshot, sem exigir uma precisão específica de formatação.
    expect(
      Math.abs(Date.parse(body.data.catalog_snapshot) - (catalog.snapshotAt?.getTime() ?? 0)),
    ).toBeLessThan(1000);
    // `age_seconds` é a idade do snapshot (AC2), não zero nem milissegundos.
    expect(body.data.age_seconds).toBeGreaterThanOrEqual(3500);
    expect(body.data.age_seconds).toBeLessThanOrEqual(3700);
    // LLM_ENABLED=false: a degradação é visível, nunca lista vazia silenciosa.
    expect(body.llm.status).toBe('disabled');
    expect(body.llm.cached).toBe(false);
    expect(body.data.degraded).toBe(true);
    expect(body.data.degraded_reason).toBe('llm_unavailable');
    expect(body.warnings).toContain('explanation_from_template');
  });

  it('rejects a short query, limit above 20 and unknown fields with 422', async () => {
    const short = await postSearch({ query: 'ab' }).expect(422);
    expect(short.body.error.code).toBe('VALIDATION_ERROR');
    expect(short.body.error.details.fields).toContain('query');
    expect(short.body.request_id).toMatch(/^req_/);

    const tooMany = await postSearch({ query: OK_QUERY, limit: 21 }).expect(422);
    expect(tooMany.body.error.code).toBe('VALIDATION_ERROR');
    expect(tooMany.body.error.details.fields).toContain('limit');

    const extra = await postSearch({ query: OK_QUERY, surprise: true }).expect(422);
    expect(extra.body.error.code).toBe('VALIDATION_ERROR');
    expect(extra.body.error.details.fields).toContain('surprise');
  });

  it('rejects an unknown category as 422 VALIDATION_ERROR/UNKNOWN_CATEGORY (D-A)', async () => {
    const response = await postSearch({
      query: OK_QUERY,
      category: 'categoria-que-nao-existe',
    }).expect(422);

    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.reason).toBe('UNKNOWN_CATEGORY');
    expect(response.body.error.details.fields).toContain('category');
  });

  it('answers 404, never 500, for an unknown or malformed skill_id', async () => {
    const unknown = await get(`/api/v1/skills/${encodeSkillId(0n)}`).expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect(unknown.body.request_id).toMatch(/^req_/);

    const malformed = await get('/api/v1/skills/nao-e-id').expect(404);
    expect(malformed.body.error.code).toBe('NOT_FOUND');
  });

  it('replays a stored search in the same order with llm.cached=true (D-D)', async () => {
    const created = await postSearch({ query: OK_QUERY }).expect(200);
    const requestId = created.body.request_id as string;
    const orderedIds = (created.body.results as ResultItem[]).map((item) => item.skill.skill_id);

    const replay = await get(`/api/v1/searches/${requestId}`).expect(200);

    expect(replay.body.request_id).toBe(requestId);
    expect(replay.body.search_id).toBe(created.body.search_id);
    expect((replay.body.results as ResultItem[]).map((item) => item.skill.skill_id)).toEqual(
      orderedIds,
    );
    expect(replay.body.llm.cached).toBe(true);
    expect(replay.body.llm.model).toBeNull();
    expect(replay.body.llm.tokens).toBeNull();
  });

  it('answers 404 for an unknown permalink and 410 for one past the 30-day retention', async () => {
    const unknown = await get('/api/v1/searches/req_01JCV8Y6Q4NAOEXISTE0000000').expect(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');

    const created = await postSearch({ query: OK_QUERY }).expect(200);
    const stored = first(store.rows);
    store.rows = [{ ...stored, created_at: new Date(Date.now() - 31 * DAY_MS) }];

    const expired = await get(`/api/v1/searches/${created.body.request_id as string}`).expect(410);
    expect(expired.body.error.code).toBe('HISTORY_EXPIRED');
    expect(expired.body.request_id).toMatch(/^req_/);
  });

  it('never echoes a forged X-Request-ID as the search request_id (C4)', async () => {
    const forged = 'req_01JCV8Y6Q4FORGED0000000000';

    const response = await postSearch({ query: OK_QUERY }).set('X-Request-ID', forged).expect(200);

    expect(response.body.request_id).toMatch(REQUEST_ID);
    // O header é opaco: se virasse chave do histórico, um cliente escolheria o
    // id do permalink — e leria (ou sobrescreveria) a busca de outro cliente.
    expect(response.body.request_id).not.toBe(forged);
    await get(`/api/v1/searches/${forged}`).expect(404);
  });

  it('answers 503 SOURCE_UNAVAILABLE when the catalog has no snapshot', async () => {
    catalog.snapshotAt = null;

    const response = await postSearch({ query: OK_QUERY }).expect(503);

    expect(response.body.error.code).toBe('SOURCE_UNAVAILABLE');
    expect(response.body.error.details.reason).toBe('cache_empty');
    expect(response.body.request_id).toMatch(/^req_/);
    expect(store.saved).toHaveLength(0);
  });

  it('maps absent detail fields to null, never zero', async () => {
    const response = await get(`/api/v1/skills/${encodeSkillId(SKILL_NULLS_ID)}`).expect(200);
    const data = response.body.data as SkillDetail;

    expect(response.body.request_id).toMatch(/^req_/);
    expect(data.skill_id).toBe(encodeSkillId(SKILL_NULLS_ID));
    expect(data.stars).toBeNull();
    expect(data.installs).toBeNull();
    expect(data.vulnerability_count).toBeNull();
    expect(data.summary).toBeNull();
    expect(data.repo_url).toBeNull();
    expect(data.skill_md_excerpt).toBeNull();
    for (const value of [data.stars, data.installs, data.vulnerability_count]) {
      expect(value).not.toBe(0);
    }
  });

  it('GET /categories lists the snapshot categories with data_snapshot', async () => {
    const response = await get('/api/v1/categories').expect(200);

    expect(response.body.request_id).toMatch(/^req_/);
    expect(response.body.data).toEqual(CATEGORIES);
    expect(response.body.data_snapshot).toMatch(RFC3339);
  });

  it('GET /skills paginates and enforces page_size/sort_by limits', async () => {
    const page = await get('/api/v1/skills').expect(200);

    expect(page.body.request_id).toMatch(/^req_/);
    expect(page.body.pagination).toEqual({
      page: 1,
      page_size: 20,
      total_items: 3,
      total_pages: 1,
    });
    // Ordem é do catálogo (`sort_by`), não do teste: o que se prova aqui é que a
    // listagem devolve as três linhas do snapshot com `skill_id` público.
    const listed = (page.body.data as SkillSummary[]).map((item) => item.skill_id);
    expect([...listed].sort()).toEqual(
      [SKILL_A, SKILL_B, SKILL_C].map((item) => item.skill_id).sort(),
    );
    expect(listed.every((skillId) => SKILL_ID.test(skillId))).toBe(true);

    const bigPage = await get('/api/v1/skills?page_size=101').expect(422);
    expect(bigPage.body.error.code).toBe('VALIDATION_ERROR');
    expect(bigPage.body.error.details.fields).toContain('page_size');

    const badSort = await get('/api/v1/skills?sort_by=foo').expect(422);
    expect(badSort.body.error.code).toBe('VALIDATION_ERROR');
    expect(badSort.body.error.details.fields).toContain('sort_by');
  });

  it('mounts the five public routes — D0 inverted (D-E)', async () => {
    // Até a F2.5 estas rotas eram placeholders de contrato: o runtime respondia
    // 404 e `health.e2e-spec.ts` exigia isso (D0). A F2.6 monta as públicas; o
    // D0 que sobra vale só para os dois de admin.
    await get('/api/v1/categories').expect(200);
    await get('/api/v1/skills').expect(200);

    const empty = await postSearch({}).expect(422);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');
    expect(empty.body.error.code).not.toBe('NOT_FOUND');
  });

  it('/metrics counts the degraded llm call as llm_calls_total{status="disabled"} (D-F)', async () => {
    await postSearch({ query: OK_QUERY }).expect(200);

    const metrics = await get('/metrics').expect(200);

    expect(metrics.text).toContain('llm_calls_total{status="disabled"}');
  });
});
