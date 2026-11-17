/**
 * Issue #10 (F2.6) — orquestração da busca (`SearchService.search`), com dublês nas portas.
 *
 * Contrato exigido do código de produção (`backend/src/search/**`):
 *
 *   // search.tokens.ts
 *   export const SEARCH_CATALOG = 'SEARCH_CATALOG';
 *   export const SEARCH_STORE = 'SEARCH_STORE';
 *
 *   // search-catalog.port.ts
 *   export interface SearchCatalog {
 *     // candidatos do cache; `SkillSummary.skill_id` já vem no formato `sk_...`
 *     search(input: { query: string; category: string | null; limit: number }):
 *       Promise<readonly SkillSummary[]>;
 *     findByIds(ids: readonly bigint[]): Promise<readonly SkillSummary[]>;   // ids do banco
 *     detail(skillId: bigint): Promise<SkillDetail | null>;
 *     snapshot(): Promise<Date | null>;      // null = cache vazio -> 503
 *     categoryExists(slug: string): Promise<boolean>;
 *     listCategories(): Promise<readonly CategoryItem[]>;
 *     listSkills(input: unknown): Promise<{ items: readonly SkillSummary[]; total_items: number }>;
 *   }
 *
 *   // search-store.port.ts — linha de `search_request` (docs/app/02-arquitetura.md §4.1)
 *   export interface StoredSearchInput {
 *     request_id: string; created_at: Date; client_hash: string; query_hash: string;
 *     query_text: string | null; intent: Intent; category_slug: string | null;
 *     result_ids: bigint[]; candidates_count: number; llm_status: LlmStatus;
 *     degraded: boolean; latency_ms: number; status: 'ok' | 'empty' | 'degraded' | 'error';
 *   }
 *   export interface StoredSearchRow extends StoredSearchInput { search_id: string }
 *   export interface SearchStore {
 *     save(record: StoredSearchInput): Promise<StoredSearchRow>;
 *     findByRequestId(requestId: string): Promise<StoredSearchRow | null>;
 *   }
 *
 *   // search.service.ts
 *   @Injectable() export class SearchService {
 *     // injeta, no mínimo: SEARCH_CATALOG, SEARCH_STORE, INTENT_PARSER e AppConfigService
 *     search(input: {
 *       query: string; category: string | null; limit: number; strictLlm: boolean;
 *       clientIp: string; requestId: string;
 *     }): Promise<SearchResponse>;
 *   }
 *
 * Decisões ratificadas que estes casos fixam: D-A (categoria inexistente é `422
 * VALIDATION_ERROR` com `details.reason === 'UNKNOWN_CATEGORY'` e `category` em
 * `details.fields`), D-C (template determinístico => warning
 * `explanation_from_template`), cache vazio => `503 SOURCE_UNAVAILABLE` com
 * `details.reason === 'cache_empty'` e **nada** persistido, snapshot > 6 h =>
 * `source_stale` com precedência sobre o status da LLM, e o `request_id` da
 * resposta é **sempre cunhado pelo servidor** (C4), nunca o header recebido.
 */
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { MetricsService } from '@/common/metrics/metrics.service';
import { AppConfigService } from '@/config/config.module';
import { loadEnv } from '@/config/env.schema';
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import type { Intent, SearchResponse } from '@/contract/dto/search-response.dto';
import type { IntentParser, IntentParserResult } from '@/llm/intent-parser';
import { INTENT_PARSER, LlmModule } from '@/llm/llm.module';
import { OpenAICompatParser } from '@/llm/openai-compat';
import { decodeSkillId, encodeSkillId } from '@/search/ids';
import type { SearchCatalog } from '@/search/search-catalog.port';
import type { SearchStore, StoredSearchInput, StoredSearchRow } from '@/search/search-store.port';
import { SearchService } from '@/search/search.service';
import { SEARCH_CATALOG, SEARCH_STORE } from '@/search/search.tokens';

const HOUR_MS = 60 * 60 * 1000;
const CLIENT_IP = '203.0.113.7';
const INCOMING_REQUEST_ID = 'req_01JCV8Y6Q4FORGED0000000000';

const OK_INTENT: Intent = {
  category: null,
  keywords: ['python', 'security'],
  filters: { exclude_with_vulnerabilities: false },
  language: 'en',
  confidence: 0.91,
};

const OK_PARSER_RESULT: IntentParserResult = {
  intent: OK_INTENT,
  status: 'ok',
  model: 'fake-model',
  tokens: { prompt: 10, completion: 5 },
};

function skill(id: bigint, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    skill_id: encodeSkillId(id),
    name: `skill-${id}`,
    source_url: 'https://skills.sh/example/skill',
    category: 'backend',
    stars: 100,
    installs: 1000,
    vulnerability_count: 0,
    security_status: 'ok',
    skill_md_present: true,
    ...overrides,
  };
}

const CANDIDATES: readonly SkillSummary[] = [
  skill(42n, { stars: 1200, installs: 8000 }),
  skill(43n, { stars: 300, installs: 2000, vulnerability_count: 1 }),
  skill(44n, {
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: 'unknown',
  }),
];

class CatalogStub implements SearchCatalog {
  skills: readonly SkillSummary[] = CANDIDATES;
  snapshotAt: Date | null = new Date(Date.now() - HOUR_MS);
  categories: string[] = ['backend', 'testing'];
  searchCalls = 0;

  search(): Promise<readonly SkillSummary[]> {
    this.searchCalls += 1;
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
    const found = this.skills.find((item) => decodeSkillId(item.skill_id) === skillId);
    return Promise.resolve(
      found === undefined
        ? null
        : { ...found, summary: null, repo_url: null, skill_md_excerpt: null, data_snapshot: null },
    );
  }

  snapshot(): Promise<Date | null> {
    return Promise.resolve(this.snapshotAt);
  }

  categoryExists(slug: string): Promise<boolean> {
    return Promise.resolve(this.categories.includes(slug));
  }

  listCategories(): Promise<readonly CategoryItem[]> {
    return Promise.resolve(
      this.categories.map((slug) => ({ slug, label_en: slug, skill_count: 0 })),
    );
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
}

/** Config validada de dev, com as duas chaves que a busca lê. */
function appConfig(overrides: { storeText?: boolean } = {}): AppConfigService {
  return {
    env: {
      ...loadEnv({ ENV: 'dev' }),
      searchLogStoreText: overrides.storeText ?? false,
      ipHashSalt: 'unit-test-salt',
    },
    isProd: false,
  };
}

/** Dublê de métrica: o `llm_calls_total` de verdade é provado no e2e por `/metrics`. */
const METRICS_STUB = {
  llmCallsTotal: { inc: (): void => undefined },
  observeLlmCall: (): void => undefined,
};

class OkIntentParser implements IntentParser {
  calls = 0;

  parse(): Promise<IntentParserResult> {
    this.calls += 1;
    return Promise.resolve(OK_PARSER_RESULT);
  }
}

interface Harness {
  service: SearchService;
  catalog: CatalogStub;
  store: StoreStub;
  parser: IntentParser;
}

async function build(
  options: {
    config?: { storeText?: boolean };
    parser?: IntentParser;
    catalog?: CatalogStub;
    store?: StoreStub;
  } = {},
): Promise<Harness> {
  const catalog = options.catalog ?? new CatalogStub();
  const store = options.store ?? new StoreStub();

  const builder = Test.createTestingModule({
    // `LLM_ENABLED=false` (o modo degradado de dev/CI) entra pelo módulo real:
    // é a fiação que decide o parser, não o teste.
    imports: [
      LlmModule.forRoot({
        enabled: false,
        baseUrl: 'https://llm.invalid/v1',
        model: 'unused-in-disabled-mode',
        timeoutS: 8,
      }),
    ],
    providers: [
      SearchService,
      { provide: SEARCH_CATALOG, useValue: catalog },
      { provide: SEARCH_STORE, useValue: store },
      { provide: AppConfigService, useValue: appConfig(options.config) },
      { provide: MetricsService, useValue: METRICS_STUB },
    ],
  });

  // O provedor falso só entra quando o caso pede um parser bom; no caso
  // `LLM_ENABLED=false` quem responde é o parser `disabled` do módulo real.
  const moduleRef = await (
    options.parser === undefined
      ? builder
      : builder.overrideProvider(INTENT_PARSER).useValue(options.parser)
  ).compile();

  return {
    service: moduleRef.get<SearchService>(SearchService),
    catalog,
    store,
    parser: moduleRef.get<IntentParser>(INTENT_PARSER),
  };
}

/** Primeiro item com erro explícito: nada de `!` escondendo lista vazia. */
function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) {
    throw new Error('lista vazia');
  }
  return item;
}

function second<T>(items: readonly T[]): T {
  const [, item] = items;
  if (item === undefined) {
    throw new Error('lista com menos de dois itens');
  }
  return item;
}

interface CapturedError {
  status: number;
  body: Record<string, unknown>;
}

/** Lê o erro como o filtro HTTP o leria, sem depender da classe concreta lançada. */
async function captureError(call: Promise<unknown>): Promise<CapturedError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      return {
        status: error.getStatus(),
        body:
          typeof response === 'string'
            ? { message: response }
            : (response as Record<string, unknown>),
      };
    }
    throw error;
  }
  throw new Error('esperava que a chamada falhasse, mas ela resolveu');
}

function detailsOf(body: Record<string, unknown>): Record<string, unknown> {
  const details = body.details;
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

const SEARCH_INPUT = {
  query: 'review pull requests for security problems in Python',
  category: null,
  limit: 5,
  strictLlm: false,
  clientIp: CLIENT_IP,
  requestId: INCOMING_REQUEST_ID,
};

describe('SearchService.search (F2.6)', () => {
  describe('degradação visível (regra 7)', () => {
    it('LLM_ENABLED=false yields disabled + llm_unavailable without opening a socket', async () => {
      const harness = await build();
      // O `Llama...` não é o cliente HTTP: nada aqui pode falar com o provedor.
      expect(harness.parser).not.toBeInstanceOf(OpenAICompatParser);

      const response: SearchResponse = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.status).toBe('disabled');
      expect(response.llm.model).toBeNull();
      expect(response.llm.tokens).toBeNull();
      expect(response.data.degraded).toBe(true);
      expect(response.data.degraded_reason).toBe('llm_unavailable');
      // Intenção lexical: o fallback sempre devolve palavra-chave, nunca lista vazia.
      expect(response.intent.keywords.length).toBeGreaterThan(0);
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.data.source).toBe('cache');
    });

    it('a good parser answer keeps the response non-degraded', async () => {
      const parser = new OkIntentParser();
      const harness = await build({ parser });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(harness.parser).toBe(parser);
      expect(parser.calls).toBe(1);
      expect(response.llm).toEqual({
        status: 'ok',
        model: 'fake-model',
        cached: false,
        tokens: { prompt: 10, completion: 5 },
      });
      expect(response.intent).toEqual(OK_INTENT);
      expect(response.data.degraded).toBe(false);
      expect(response.data.degraded_reason).toBeNull();
      // D-C: não existe `explain` na porta da LLM; o texto vem do template.
      expect(response.warnings).toContain('explanation_from_template');
    });
  });

  /**
   * Issue #10 (revisão): `source_stale` fala do **frescor do snapshot**, nunca da
   * degradação. Com `LLM_ENABLED=false` o snapshot fresco é degradado por
   * `llm_unavailable`, e isso não é catálogo velho — nem na busca nem no replay.
   */
  describe('source_stale is snapshot freshness, not degradation (issue #10)', () => {
    it('a fresh snapshot with LLM_ENABLED=false carries no source_stale warning', async () => {
      const harness = await build();

      const response = await harness.service.search(SEARCH_INPUT);

      // A degradação acontece, e o snapshot continua fresco: avisos diferentes.
      expect(response.llm.status).toBe('disabled');
      expect(response.data.degraded).toBe(true);
      expect(response.data.degraded_reason).toBe('llm_unavailable');
      expect(response.data.age_seconds).toBeLessThan(6 * 3600);
      expect(response.warnings).not.toContain('source_stale');
      expect(response.warnings).toContain('explanation_from_template');
    });

    it('a fresh replay does not warn source_stale either', async () => {
      // Mesmo cenário do e2e: busca feita com LLM_ENABLED=false, então a linha
      // gravada já é degradada (`llm_unavailable`). `source_stale` é sobre o
      // snapshot, e um snapshot fresco não pode virar aviso de catálogo velho.
      const harness = await build();
      const created = await harness.service.search(SEARCH_INPUT);

      const replay = await harness.service.replay(created.request_id);

      expect(replay.llm.cached).toBe(true);
      expect(replay.llm.status).toBe('disabled');
      expect(replay.data.degraded).toBe(true);
      expect(replay.data.degraded_reason).toBe('llm_unavailable');
      expect(replay.warnings).not.toContain('source_stale');
    });

    it('a 7-hour-old snapshot warns source_stale on both the search and the replay', async () => {
      const catalog = new CatalogStub();
      catalog.snapshotAt = new Date(Date.now() - 7 * HOUR_MS);
      const harness = await build({ catalog, parser: new OkIntentParser() });

      const searched = await harness.service.search(SEARCH_INPUT);
      const replay = await harness.service.replay(searched.request_id);

      expect(searched.warnings).toContain('source_stale');
      expect(replay.warnings).toContain('source_stale');
      expect(replay.data.degraded_reason).toBe('source_stale');
    });
  });

  describe('estados de erro e borda do cache', () => {
    it('an empty cache is 503 SOURCE_UNAVAILABLE/cache_empty and persists nothing', async () => {
      const catalog = new CatalogStub();
      catalog.snapshotAt = null;
      const harness = await build({ catalog, parser: new OkIntentParser() });

      const error = await captureError(harness.service.search(SEARCH_INPUT));

      expect(error.status).toBe(503);
      expect(detailsOf(error.body).reason).toBe('cache_empty');
      expect(harness.store.saved).toHaveLength(0);
    });

    it('a snapshot older than 6 hours degrades as source_stale, ahead of the LLM status', async () => {
      const catalog = new CatalogStub();
      catalog.snapshotAt = new Date(Date.now() - 7 * HOUR_MS);
      const harness = await build({ catalog, parser: new OkIntentParser() });

      const response = await harness.service.search(SEARCH_INPUT);

      // `source_stale` vence `llm_unavailable` (§7.4), e aqui a LLM nem degradou:
      // a precedência é provada sem depender do status do parser.
      expect(response.llm.status).toBe('ok');
      expect(response.data.degraded).toBe(true);
      expect(response.data.degraded_reason).toBe('source_stale');
      expect(response.data.age_seconds).toBeGreaterThanOrEqual(7 * 3600 - 60);
      expect(response.warnings).toContain('source_stale');
    });

    it('an unknown category is 422 VALIDATION_ERROR/UNKNOWN_CATEGORY and stops before the cache', async () => {
      const harness = await build({ parser: new OkIntentParser() });

      const error = await captureError(
        harness.service.search({ ...SEARCH_INPUT, category: 'categoria-que-nao-existe' }),
      );

      expect(error.status).toBe(422);
      expect(detailsOf(error.body).reason).toBe('UNKNOWN_CATEGORY');
      expect(detailsOf(error.body).fields).toContain('category');
      expect(harness.catalog.searchCalls).toBe(0);
      expect(harness.store.saved).toHaveLength(0);
    });

    it('no candidates is a 200 with an explained empty list, never a silent blank', async () => {
      const catalog = new CatalogStub();
      catalog.skills = [];
      const harness = await build({ catalog, parser: new OkIntentParser() });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.results).toEqual([]);
      expect(response.recommendation).toBeNull();
      expect(response.warnings).toContain('no_results');
    });
  });

  describe('persistência da busca (histórico US-09)', () => {
    it('mints a server-side request_id and stores the ranked ids in order', async () => {
      const harness = await build({ parser: new OkIntentParser() });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(harness.store.saved).toHaveLength(1);
      const stored = first(harness.store.saved);
      // C4: o header recebido é opaco e não vira chave do histórico.
      expect(response.request_id).not.toBe(INCOMING_REQUEST_ID);
      expect(response.request_id).toMatch(/^req_[0-9A-Z]{26}$/);
      expect(stored.request_id).toBe(response.request_id);
      expect(response.search_id).toBe(harness.store.searchId);
      expect(stored.result_ids).toEqual(
        response.results.map((item) => decodeSkillId(item.skill.skill_id)),
      );
      expect(stored.result_ids.every((id) => typeof id === 'bigint')).toBe(true);
      expect(stored.status).toBe('ok');
      expect(stored.llm_status).toBe('ok');
    });

    it('stores no query text by default and no raw IP (SEARCH_LOG_STORE_TEXT=false)', async () => {
      const harness = await build({ parser: new OkIntentParser() });

      await harness.service.search(SEARCH_INPUT);

      const stored = first(harness.store.saved);
      expect(stored.query_text).toBeNull();
      expect(stored.query_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.client_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.client_hash).not.toContain(CLIENT_IP);
      expect(JSON.stringify(stored)).not.toContain(CLIENT_IP);
      expect(stored.category_slug).toBeNull();

      // O hash é estável para o mesmo cliente e sal (não é id de requisição).
      await harness.service.search(SEARCH_INPUT);
      expect(second(harness.store.saved).client_hash).toBe(stored.client_hash);
    });

    it('stores the query text only when SEARCH_LOG_STORE_TEXT=true', async () => {
      const harness = await build({ config: { storeText: true }, parser: new OkIntentParser() });

      await harness.service.search(SEARCH_INPUT);

      expect(first(harness.store.saved).query_text).toBe(SEARCH_INPUT.query);
    });

    /**
     * Issue #10 (revisão): com `SEARCH_LOG_STORE_TEXT=true` o texto é **gravado**
     * no banco, mas a projeção JSON de log/auditoria continua sem ele — §8.5
     * proíbe o texto da consulta em log, e é esta projeção que vai para o log.
     */
    it('keeps the query text out of the JSON projection even when it is stored', async () => {
      const harness = await build({ config: { storeText: true }, parser: new OkIntentParser() });

      await harness.service.search(SEARCH_INPUT);

      const stored = first(harness.store.saved);
      // Gravado no histórico (o permalink de §5.4 depende disto).
      expect(stored.query_text).toBe(SEARCH_INPUT.query);

      const projection = stored.toJSON() as Record<string, unknown>;
      expect(projection).not.toHaveProperty('query_text');
      // `JSON.stringify` usa `toJSON`: é isto que um log do registro veria.
      const logged = JSON.stringify(stored);
      expect(logged).not.toContain(SEARCH_INPUT.query);
      expect(logged).not.toContain('pull requests');
      // A projeção continua auditável: hash, ids em decimal e desfecho.
      expect(projection.query_hash).toBe(stored.query_hash);
      expect(projection.result_ids).toEqual(stored.result_ids.map((id) => id.toString()));
      expect(projection.status).toBe('ok');
    });
  });
});
