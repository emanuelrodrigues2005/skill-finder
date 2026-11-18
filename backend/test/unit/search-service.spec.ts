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
import type { ExplainParser, ExplainRequest, ExplainResult } from '@/llm/explain-parser';
import type { IntentParser, IntentParserResult } from '@/llm/intent-parser';
import { EXPLAIN_PORT, INTENT_PARSER, LlmModule } from '@/llm/llm.module';
import { OpenAICompatParser } from '@/llm/openai-compat';
import { decodeSkillId, encodeSkillId } from '@/search/ids';
import type { SearchCatalog, SearchCatalogInput } from '@/search/search-catalog.port';
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
  /** Entradas recebidas em `search`, na ordem: é o contrato com o recuperador. */
  readonly searchInputs: SearchCatalogInput[] = [];
  /** Evidência extra do detalhe: só o rank 1 pode chegar ao passo de explicação. */
  summary: string | null = null;
  skillMdExcerpt: string | null = null;
  /** Ids pedidos ao detalhe: prova que a busca não paga uma consulta por item. */
  readonly detailInputs: bigint[] = [];

  search(input: SearchCatalogInput): Promise<readonly SkillSummary[]> {
    this.searchCalls += 1;
    this.searchInputs.push(input);
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
    this.detailInputs.push(skillId);
    const found = this.skills.find((item) => decodeSkillId(item.skill_id) === skillId);
    return Promise.resolve(
      found === undefined
        ? null
        : {
            ...found,
            summary: this.summary,
            repo_url: null,
            skill_md_excerpt: this.skillMdExcerpt,
            data_snapshot: null,
          },
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
  /** Orçamento recebido do serviço: o mesmo que o passo de explicação vai ver. */
  deadlineAtMs?: number;

  parse(
    _query: string,
    _categories: readonly string[],
    budget?: { readonly deadlineAtMs?: number },
  ): Promise<IntentParserResult> {
    this.calls += 1;
    this.deadlineAtMs = budget?.deadlineAtMs;
    return Promise.resolve(OK_PARSER_RESULT);
  }
}

/** Intenção de confiança baixa: o passo de explicação não deve ser tentado (#42). */
class LowConfidenceParser implements IntentParser {
  parse(): Promise<IntentParserResult> {
    return Promise.resolve({
      intent: { ...OK_INTENT, confidence: 0.2 },
      status: 'low_confidence',
      model: null,
      tokens: null,
    });
  }
}

/**
 * Prosa do "agente" determinística: cita a skill só por `{{skill:<id>}}` e diz
 * algo que o template nunca diz, para os casos distinguirem **de onde** veio o
 * texto da resposta.
 */
class ProseExplain implements ExplainParser {
  readonly requests: ExplainRequest[] = [];

  explain(request: ExplainRequest): Promise<ExplainResult> {
    this.requests.push(request);
    const [rank1] = request.candidates;
    return Promise.resolve({
      items: request.candidates.map((candidate) => ({
        skill_id: candidate.skill_id,
        why: `{{skill:${candidate.skill_id}}} atende ao pedido segundo o agente.`,
        caveats: null,
        repaired: false,
      })),
      recommendation: {
        skill_id: rank1?.skill_id ?? '',
        why: `{{skill:${rank1?.skill_id ?? ''}}} é a recomendação do agente para esta busca.`,
        repaired: false,
      },
      status: 'ok',
      reason: null,
      model: 'fake-model',
      tokens: { prompt: 20, completion: 10 },
    });
  }
}

/** Porta `explain` com desfecho fixo — o caso controla o status do passo. */
class ExplainStub implements ExplainParser {
  readonly requests: ExplainRequest[] = [];

  constructor(private readonly result: ExplainResult) {}

  explain(request: ExplainRequest): Promise<ExplainResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

/** Item que precisou de reparo na escada de validação (§5.3, degrau 5). */
class RepairedExplain implements ExplainParser {
  explain(request: ExplainRequest): Promise<ExplainResult> {
    return Promise.resolve({
      items: request.candidates.map((candidate) => ({
        skill_id: candidate.skill_id,
        why: `{{skill:${candidate.skill_id}}} texto que precisou de reparo.`,
        caveats: 'risco apontado pelo agente',
        repaired: true,
      })),
      recommendation: {
        skill_id: request.candidates[0]?.skill_id ?? '',
        why: 'a recomendação também precisou de reparo.',
        repaired: true,
      },
      status: 'repaired',
      reason: null,
      model: 'fake-model',
      tokens: null,
    });
  }
}

/**
 * Prosa do agente com `{{skill:<skill_id>}}` **também no `caveats`**.
 *
 * O degrau 5 do `explain-parser` preserva de propósito o placeholder de id do
 * conjunto: quem substitui pelo nome vindo do banco é o `resolvePlaceholders` de
 * `src/search/explanation.ts`. Este duplê reproduz a saída do parser real — é o
 * caso do achado HIGH do parecer da #42.
 */
class CaveatsWithPlaceholder implements ExplainParser {
  readonly caveatsTemplate = 'compare com {{skill:SKILL_ID}} antes de instalar';

  explain(request: ExplainRequest): Promise<ExplainResult> {
    const [rank1, rank2] = request.candidates;
    const rank2Id = rank2?.skill_id ?? '';
    return Promise.resolve({
      items: request.candidates.map((candidate) => ({
        skill_id: candidate.skill_id,
        why: `{{skill:${candidate.skill_id}}} atende ao pedido segundo o agente.`,
        caveats:
          candidate.skill_id === rank1?.skill_id
            ? this.caveatsTemplate.replace('SKILL_ID', rank2Id)
            : null,
        repaired: false,
      })),
      recommendation: {
        skill_id: rank1?.skill_id ?? '',
        why: `{{skill:${rank1?.skill_id ?? ''}}} é a recomendação do agente para esta busca.`,
        repaired: false,
      },
      status: 'ok',
      reason: null,
      model: 'fake-model',
      tokens: null,
    });
  }
}

/**
 * Catálogo cujo `detail()` lança — banco fora do ar no enriquecimento do rank 1.
 *
 * O detalhe alimenta `summary`/`skill_md_excerpt` do rank 1 no passo 7 (§7.5), que
 * é **opcional** por contrato: um erro aqui não pode derrubar a busca com 500.
 */
class ThrowingDetailCatalog extends CatalogStub {
  override detail(): Promise<SkillDetail | null> {
    return Promise.reject(new Error('catalog.detail fora do ar'));
  }
}

/**
 * Cache devolvendo prosa de **outra** ordem: a recomendação aponta para o segundo
 * colocado. O serviço tem de revalidar contra o rank 1 antes de responder (§4).
 */
class WrongOrderRecommendation implements ExplainParser {
  explain(request: ExplainRequest): Promise<ExplainResult> {
    const second = request.candidates[1];
    return Promise.resolve({
      items: request.candidates.map((candidate) => ({
        skill_id: candidate.skill_id,
        why: `{{skill:${candidate.skill_id}}} atende ao pedido.`,
        caveats: null,
        repaired: false,
      })),
      recommendation: {
        skill_id: second?.skill_id ?? '',
        why: `{{skill:${second?.skill_id ?? ''}}} é a recomendação do agente para esta busca.`,
        repaired: false,
      },
      status: 'ok',
      reason: null,
      model: null,
      tokens: null,
    });
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
    explain?: ExplainParser;
  } = {},
): Promise<Harness> {
  const catalog = options.catalog ?? new CatalogStub();
  const store = options.store ?? new StoreStub();

  let builder = Test.createTestingModule({
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
  if (options.parser !== undefined) {
    builder = builder.overrideProvider(INTENT_PARSER).useValue(options.parser);
  }
  // A porta de explicação é sempre injetada (é o passo 7 do #42): o duplo entra
  // por `overrideProvider`, nunca por variável de ambiente (regra 5).
  if (options.explain !== undefined) {
    builder = builder.overrideProvider(EXPLAIN_PORT).useValue(options.explain);
  }

  const moduleRef = await builder.compile();

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
        // `explain_status: null` porque o contrato o marca `required` (issue #39).
        // Congelar o objeto sem ele foi o que deixou "obrigatório e ausente"
        // passar verde na revisão: o `toEqual` exato é a guarda contra isso.
        explain_status: null,
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

  /**
   * Issue #40: o `search_doc` é indexado em inglês. O serviço entrega ao
   * recuperador a consulta crua (só para o `name ILIKE`) **e** os `keywords_en`
   * da intenção; sem eles, cai nas `keywords` da própria intenção — a busca nunca
   * morre por falta de termo em inglês.
   */
  describe('english keywords to the FTS (issue #40)', () => {
    const PT_INPUT = {
      ...SEARCH_INPUT,
      query: 'quero uma skill para documentar uma api em portugues',
    };

    const PT_INTENT: Intent = {
      category: null,
      keywords: ['documentar', 'api'],
      filters: { exclude_with_vulnerabilities: false },
      language: 'pt',
      confidence: 0.88,
    };

    class KeywordsParser implements IntentParser {
      constructor(private readonly keywordsEn?: readonly string[]) {}

      parse(): Promise<IntentParserResult> {
        return Promise.resolve({
          intent: PT_INTENT,
          status: 'ok',
          model: 'fake-model',
          tokens: null,
          ...(this.keywordsEn === undefined ? {} : { keywordsEn: this.keywordsEn }),
        });
      }
    }

    it('sends the english keywords of the intent and the raw query to the catalog', async () => {
      const harness = await build({ parser: new KeywordsParser(['document', 'api']) });

      await harness.service.search(PT_INPUT);

      const input = first(harness.catalog.searchInputs);
      // O `tsquery` recebe os termos em inglês; o `ILIKE` continua com o cru.
      expect(input.keywords).toEqual(['document', 'api']);
      expect(input.query).toBe(PT_INPUT.query);
    });

    it('falls back to the intent keywords when the step brings no english keyword', async () => {
      const harness = await build({ parser: new KeywordsParser() });

      await harness.service.search(PT_INPUT);

      const input = first(harness.catalog.searchInputs);
      expect(input.keywords).toEqual(PT_INTENT.keywords);
      expect(input.query).toBe(PT_INPUT.query);
    });

    it('never sends an empty keyword list, even for the disabled parser', async () => {
      const harness = await build();

      await harness.service.search(PT_INPUT);

      expect(first(harness.catalog.searchInputs).keywords.length).toBeGreaterThan(0);
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

  /**
   * Issue #42 (F2.10): o passo 7 — a prosa do agente chega ao usuário.
   *
   * O contrato com a porta `explain` (`backend/src/llm/explain-parser.ts`):
   * - um **único** `deadlineAtMs` para os dois passos de LLM da busca;
   * - `candidates` na ordem do ranking, com `summary`/`skill_md_excerpt` só do
   *   rank 1 (é o que informa a decisão e corta ~1,6k tokens);
   * - `catalog_snapshot` no pedido (entra na chave do cache de explicação);
   * - `result.status` -> `llm.explain_status`, `null` quando o passo não foi
   *   tentado; falha do explain **não** degrada a resposta;
   * - `items[].why` (ainda com `{{skill:<id>}}`) é `template` de `explainItem`,
   *   nunca atribuído direto a `results[].explanation`.
   */
  describe('explain step (issue #42)', () => {
    it('serves the agent prose, resolves the placeholder and drops the template warning', async () => {
      const explain = new ProseExplain();
      const parser = new OkIntentParser();
      const harness = await build({ parser, explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(explain.requests).toHaveLength(1);
      const request = first(explain.requests);
      // Um orçamento só: o mesmo instante para a intenção e para a explicação.
      expect(request.deadlineAtMs).toBe(parser.deadlineAtMs);
      expect(typeof request.deadlineAtMs).toBe('number');
      expect(request.deadlineAtMs).toBeGreaterThan(Date.now());
      // `catalog_snapshot` é o mesmo instante publicado em `data.catalog_snapshot`.
      expect(request.catalog_snapshot).toBe(response.data.catalog_snapshot);
      // `candidates[0]` é o rank 1, na ordem do ranking.
      expect(request.candidates.map((candidate) => candidate.skill_id)).toEqual(
        response.results.map((item) => item.skill.skill_id),
      );

      expect(response.llm.explain_status).toBe('ok');
      // Todas as explicações vieram do agente: sem aviso de template.
      expect(response.warnings).not.toContain('explanation_from_template');

      for (const item of response.results) {
        // Placeholder resolvido pelo `explainItem`: nome publicado, sem `{{`.
        expect(item.explanation).toContain(item.skill.name);
        expect(item.explanation).not.toContain('{{');
        // O texto do template determinístico não aparece: a prosa é a do agente.
        expect(item.explanation).not.toContain('Todos os dados do score vieram');
      }
      expect(response.recommendation?.skill_id).toBe(response.results[0]?.skill.skill_id);
      expect(response.recommendation?.text).toContain('recomendação do agente');
      expect(response.recommendation?.text).not.toContain('{{');
      // Falha do explain não muda a intenção: a resposta não degrada.
      expect(response.data.degraded).toBe(false);
      expect(response.data.degraded_reason).toBeNull();
    });

    it('a failing explain keeps 200 without degrading and fills explain_status', async () => {
      const explain = new ExplainStub({
        items: [],
        recommendation: null,
        status: 'unavailable',
        reason: 'provider_error',
        model: null,
        tokens: null,
      });
      const harness = await build({ parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBe('unavailable');
      // §7.4: `data.degraded` fala de intenção/catálogo, nunca do passo 7.
      expect(response.data.degraded).toBe(false);
      expect(response.data.degraded_reason).toBeNull();
      // Fallback determinístico, item a item, e o aviso que já existia (D-C).
      for (const item of response.results) {
        expect(item.explanation).toContain('estrelas');
        expect(item.explanation).not.toContain('{{');
      }
      expect(response.warnings).toContain('explanation_from_template');
      expect(response.recommendation?.skill_id).toBe(response.results[0]?.skill.skill_id);
    });

    it('a port that throws still answers 200 with the template instead of dying', async () => {
      // §7.4: a busca nunca morre por causa da LLM. O cliente real devolve
      // `unavailable` em vez de lançar, mas o serviço não pode depender de a porta
      // ser bem-comportada — um erro solto aqui derrubaria a resposta inteira.
      const explain: ExplainParser = {
        explain(): Promise<ExplainResult> {
          throw new Error('porta fora do contrato');
        },
      };
      const harness = await build({ parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBe('unavailable');
      expect(response.data.degraded).toBe(false);
      expect(response.results).toHaveLength(CANDIDATES.length);
      expect(response.warnings).toContain('explanation_from_template');
    });

    it('invalid_ids from the explain step falls back to the deterministic template', async () => {
      const explain = new ExplainStub({
        items: [],
        recommendation: null,
        status: 'invalid_ids',
        reason: 'invalid_ids',
        model: null,
        tokens: null,
      });
      const harness = await build({ parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBe('invalid_ids');
      expect(response.results).toHaveLength(CANDIDATES.length);
      for (const item of response.results) {
        expect(item.explanation.trim().length).toBeGreaterThan(0);
        expect(item.explanation).not.toContain('{{');
      }
      expect(response.warnings).toContain('explanation_from_template');
      expect(response.data.degraded).toBe(false);
    });

    it('a replay does not attempt the explain step and answers explain_status null (replay)', async () => {
      const explain = new ProseExplain();
      const harness = await build({ parser: new OkIntentParser(), explain });

      const created = await harness.service.search(SEARCH_INPUT);
      expect(explain.requests).toHaveLength(1);

      const replay = await harness.service.replay(created.request_id);

      // Nenhum provedor é chamado no replay: o passo 7 não é tentado.
      expect(explain.requests).toHaveLength(1);
      expect(replay.llm.explain_status).toBeNull();
      expect(replay.llm.cached).toBe(true);
      expect(replay.warnings).toContain('explanation_from_template');
      expect(replay.results.map((item) => item.skill.skill_id)).toEqual(
        created.results.map((item) => item.skill.skill_id),
      );
    });

    it('does not attempt the explain step below 0.35 of intent confidence', async () => {
      const explain = new ProseExplain();
      const harness = await build({ parser: new LowConfidenceParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(explain.requests).toHaveLength(0);
      // Ausência de tentativa, não falha (§6.3).
      expect(response.llm.explain_status).toBeNull();
      expect(response.warnings).toContain('explanation_from_template');
      expect(response.data.degraded).toBe(true);
      expect(response.data.degraded_reason).toBe('llm_unavailable');
    });

    it('sends the summary and the SKILL.md excerpt of the rank 1 only (rank 1)', async () => {
      const catalog = new CatalogStub();
      catalog.summary = 'resumo do rank 1';
      catalog.skillMdExcerpt = 'trecho do SKILL.md do rank 1';
      const explain = new ProseExplain();
      const harness = await build({ catalog, parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      const request = first(explain.requests);
      expect(request.candidates[0]?.summary).toBe('resumo do rank 1');
      expect(request.candidates[0]?.skill_md_excerpt).toBe('trecho do SKILL.md do rank 1');
      // Os demais candidatos vão só com números: é o corte de ~1,6k tokens.
      for (const candidate of request.candidates.slice(1)) {
        expect(candidate.summary).toBeNull();
        expect(candidate.skill_md_excerpt).toBeNull();
      }
      // A evidência extra é buscada uma vez, para o rank 1 — nunca por item.
      const rank1Id = response.results[0]?.skill.skill_id ?? '';
      expect(catalog.detailInputs.map((id) => encodeSkillId(id))).toEqual([rank1Id]);
    });

    it('gives the explain request the catalog snapshot of the answer (cache_key)', async () => {
      const catalog = new CatalogStub();
      const explain = new ProseExplain();
      const harness = await build({ catalog, parser: new OkIntentParser(), explain });

      const firstRun = await harness.service.search(SEARCH_INPUT);
      catalog.snapshotAt = new Date(Date.now() - 2 * HOUR_MS);
      const secondRun = await harness.service.search(SEARCH_INPUT);

      // A prosa cita estrelas/instalações: sem o snapshot na chave do cache, a
      // segunda busca receberia números vencidos (§4.1).
      expect(first(explain.requests).catalog_snapshot).toBe(firstRun.data.catalog_snapshot);
      expect(second(explain.requests).catalog_snapshot).toBe(secondRun.data.catalog_snapshot);
      expect(first(explain.requests).catalog_snapshot).not.toBe(
        second(explain.requests).catalog_snapshot,
      );
    });

    it('carries the agent caveats and flags a repaired item (§5.3)', async () => {
      const harness = await build({ parser: new OkIntentParser(), explain: new RepairedExplain() });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBe('repaired');
      const top = first(response.results);
      expect(top.caveats).toBe('risco apontado pelo agente');
      expect(top.flags).toContain('explanation_repaired');
    });

    /**
     * Achado HIGH do parecer da #42: o `caveats` do agente era publicado **cru**.
     * O degrau 5 do `explain-parser` preserva `{{skill:<id>}}` de propósito (o
     * resolvedor é do backend), então publicar o texto do item sem passar pelo
     * mesmo caminho da explicação põe `{{...}}` na tela — justamente o formato que
     * o prompt incentiva o modelo a usar.
     */
    it('resolves the agent caveats placeholder instead of publishing {{...}} (HIGH #42)', async () => {
      const explain = new CaveatsWithPlaceholder();
      const harness = await build({ parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      const top = first(response.results);
      const target = second(response.results);
      expect(top.caveats).not.toBeNull();
      expect(top.caveats).toContain('compare com');
      // O placeholder vira o nome do conjunto ranqueado, como na explicação.
      expect(top.caveats).toContain(target.skill.name);
      expect(top.caveats).not.toContain('{{');
      // A garantia é da resposta inteira, não de um campo: nada de `{{` em nenhum
      // `caveats`, `explanation` ou `recommendation.text` publicados.
      expect(JSON.stringify(response)).not.toContain('{{');
    });

    /**
     * Achado MEDIUM do parecer da #42: `catalog.detail()` do rank 1 rodava **fora**
     * do `try`. Um erro ali derrubava a busca inteira com 500, contra o contrato de
     * que o passo 7 é opcional (§7.4): a resposta sai no template determinístico.
     */
    it('a throwing catalog.detail() does not turn the search into a 500 (MEDIUM #42)', async () => {
      const explain = new ProseExplain();
      const harness = await build({
        parser: new OkIntentParser(),
        catalog: new ThrowingDetailCatalog(),
        explain,
      });

      // Se o erro escapasse, `search` rejeitaria; `resolves` é a asserção de 200.
      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBe('unavailable');
      // Falha do passo 7 não é degradação de intenção/catálogo (§7.4).
      expect(response.data.degraded).toBe(false);
      expect(response.data.degraded_reason).toBeNull();
      expect(response.results).toHaveLength(CANDIDATES.length);
      for (const item of response.results) {
        expect(item.explanation).toContain('estrelas');
        expect(item.explanation).not.toContain('{{');
      }
      expect(response.warnings).toContain('explanation_from_template');
      expect(response.recommendation?.skill_id).toBe(response.results[0]?.skill.skill_id);
      // Sem evidência do rank 1 o passo 7 nem é tentado: nenhum provedor chamado.
      expect(explain.requests).toHaveLength(0);
    });

    it('revalidates recommendation.skill_id against the rank 1 before answering', async () => {
      const harness = await build({
        parser: new OkIntentParser(),
        explain: new WrongOrderRecommendation(),
      });

      const response = await harness.service.search(SEARCH_INPUT);

      // O cache pode devolver recomendação de outra ordem: vale o rank 1 desta
      // resposta, com o texto determinístico — nunca a prosa do outro item.
      expect(response.recommendation?.skill_id).toBe(response.results[0]?.skill.skill_id);
      expect(response.recommendation?.text).not.toContain('recomendação do agente');
      expect(response.llm.explain_status).toBe('ok');
    });

    it('has no candidate to explain when the catalog returns nothing', async () => {
      const catalog = new CatalogStub();
      catalog.skills = [];
      const explain = new ProseExplain();
      const harness = await build({ catalog, parser: new OkIntentParser(), explain });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(explain.requests).toHaveLength(0);
      expect(response.llm.explain_status).toBeNull();
      expect(response.warnings).toContain('no_results');
      expect(response.warnings).not.toContain('explanation_from_template');
    });

    it('the disabled port keeps explain_status null and the template (LLM_ENABLED=false)', async () => {
      // Sem `explain` no harness, quem responde é o cliente `disabled` do módulo.
      const harness = await build({ parser: new OkIntentParser() });

      const response = await harness.service.search(SEARCH_INPUT);

      expect(response.llm.explain_status).toBeNull();
      expect(response.warnings).toContain('explanation_from_template');
      for (const item of response.results) {
        expect(item.explanation.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
