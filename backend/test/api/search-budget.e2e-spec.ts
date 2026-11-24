/**
 * Issue #35 — orçamento **global** diário de chamadas da LLM.
 *
 * O rate limit por cliente (`search-throttler.guard.ts`) conta
 * `sha256(salt:ip)`: trocar de IP dá um bucket novo, então o teto real é
 * `n de IPs x RATE_LIMIT_SEARCH_PER_DAY`. O orçamento desta issue é um só para o
 * processo inteiro, porque o recurso protegido (a chave e o crédito do provedor)
 * também é um só. Por isso este spec usa **IPs distintos**: se o teste passasse
 * de um IP só, um bucket por cliente também passaria.
 *
 * Casos:
 *   A. `LLM_DAILY_CALL_BUDGET=2`: duas buscas de IPs diferentes respondem 200 e a
 *      terceira — de um terceiro IP — responde 429 `RATE_LIMITED` com
 *      `details.scope="global"`, sem chegar ao serviço (nada persiste) e **sem**
 *      incrementar `llm_calls_total` (a LLM não foi chamada).
 *   B. `/metrics` publica `rate_limited_total{scope="global"}`.
 *   C. a cota volta na virada do dia UTC, com `Retry-After` contado do relógio
 *      **injetado** (`FakeClock`), nunca de 24 h fixas.
 *
 * A persistência (reinício não zera) fica no nível de integração: aqui as portas
 * são duplos e nenhum socket de banco é aberto (regra 5).
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import { configureApp } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';
import { CLOCK, type Clock } from '@/search/clock';
import type { DailyLlmBudgetStore } from '@/search/daily-llm-budget.port';
import { decodeSkillId, encodeSkillId } from '@/search/ids';
import type {
  ListSkillsInput,
  SearchCatalog,
  SearchCatalogInput,
  SkillPage,
} from '@/search/search-catalog.port';
import type { SearchStore, StoredSearchInput, StoredSearchRow } from '@/search/search-store.port';
import { DAILY_LLM_BUDGET_STORE, SEARCH_CATALOG, SEARCH_STORE } from '@/search/search.tokens';

// Configuração de teste de `test/setup.ts`; reforçada porque um `.env` local não
// pode mudar o cenário.
process.env.LLM_ENABLED = 'false';
process.env.SEARCH_LOG_STORE_TEXT = 'false';

/** O teto do cenário: o terceiro passo de intenção do dia não acontece. */
const DAILY_BUDGET = 2;

const ORIGINAL_LIMITS = {
  min: process.env.RATE_LIMIT_SEARCH_PER_MIN,
  day: process.env.RATE_LIMIT_SEARCH_PER_DAY,
  budget: process.env.LLM_DAILY_CALL_BUDGET,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_SECONDS = 86_400;
const QUERY = 'review pull requests for security problems in Python';

/** Série que o passo de intenção incrementa com `LLM_ENABLED=false`. */
const LLM_DISABLED_SERIES = 'llm_calls_total{status="disabled"}';
const GLOBAL_RATE_LIMIT_SERIES = 'rate_limited_total{scope="global"}';

const SKILLS: readonly SkillSummary[] = [
  {
    skill_id: encodeSkillId(42n),
    name: 'python-security-review',
    source_url: 'https://skills.sh/example/python-security-review',
    category: 'backend',
    stars: 1200,
    installs: 8000,
    vulnerability_count: 0,
    security_status: 'ok',
    skill_md_present: true,
  },
];

const CATEGORIES: readonly CategoryItem[] = [
  { slug: 'backend', label_en: 'Backend', skill_count: 1 },
];

function freshSnapshot(): Date {
  return new Date(Date.now() - HOUR_MS / 60);
}

/**
 * Valor de uma série de `/metrics`; `NaN` quando ela não existe — é a diferença
 * entre "contador em zero" e "série ausente".
 */
function metricValue(text: string, series: string): number {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? Number.NaN : Number(line.slice(series.length + 1));
}

/** Mesmo duplo de porta de `search.e2e-spec.ts`: nada aqui abre socket. */
class CatalogStub implements SearchCatalog {
  readonly skills: readonly SkillSummary[] = SKILLS;
  readonly categories: readonly CategoryItem[] = CATEGORIES;

  search(_input: SearchCatalogInput): Promise<readonly SkillSummary[]> {
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

  detail(_skillId: bigint): Promise<SkillDetail | null> {
    return Promise.resolve(null);
  }

  snapshot(): Promise<Date | null> {
    return Promise.resolve(freshSnapshot());
  }

  categoryExists(slug: string): Promise<boolean> {
    return Promise.resolve(this.categories.some((category) => category.slug === slug));
  }

  listCategories(): Promise<readonly CategoryItem[]> {
    return Promise.resolve(this.categories);
  }

  listSkills(_input: ListSkillsInput): Promise<SkillPage> {
    return Promise.resolve({ items: this.skills, total_items: this.skills.length });
  }
}

class StoreStub implements SearchStore {
  readonly saved: StoredSearchInput[] = [];
  readonly rows: StoredSearchRow[] = [];
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

class PrismaStub {
  ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

/**
 * Orçamento em memória: aqui o alvo é o contrato HTTP (429, métrica, IP não
 * fura), não a persistência — essa é provada contra o Postgres real em
 * `test/integration/search-budget.spec.ts`. A regra da reserva é a mesma do
 * adaptador: cota por dia do calendário e chamada recusada não consome cota.
 */
class InMemoryBudgetStore implements DailyLlmBudgetStore {
  readonly calls = new Map<string, number>();

  tryReserve(day: string, limit: number): Promise<boolean> {
    const used = this.calls.get(day) ?? 0;
    if (used >= limit) {
      return Promise.resolve(false);
    }
    this.calls.set(day, used + 1);
    return Promise.resolve(true);
  }
}

/** Relógio controlado: a virada do dia é do teste, não da máquina. */
class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = initial;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface Harness {
  readonly app: INestApplication;
  readonly store: StoreStub;
  readonly budget: InMemoryBudgetStore;
  readonly clock: FakeClock;
}

async function createApp(options: { clock?: FakeClock } = {}): Promise<Harness> {
  const store = new StoreStub();
  const budget = new InMemoryBudgetStore();
  const clock = options.clock ?? new FakeClock(new Date());

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(new PrismaStub())
    .overrideProvider(SEARCH_CATALOG)
    .useValue(new CatalogStub())
    .overrideProvider(SEARCH_STORE)
    .useValue(store)
    .overrideProvider(DAILY_LLM_BUDGET_STORE)
    .useValue(budget)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, store, budget, clock };
}

function postSearch(app: INestApplication, forwardedFor: string): request.Test {
  return request(app.getHttpServer())
    .post('/api/v1/search')
    .set('X-Forwarded-For', forwardedFor)
    .send({ query: QUERY });
}

function get(app: INestApplication, path: string): request.Test {
  return request(app.getHttpServer()).get(path);
}

describe('POST /api/v1/search — global daily LLM budget (#35)', () => {
  let harness: Harness;

  beforeAll(async () => {
    // Lidas na construção do módulo: tem de ser antes do createTestingModule.
    process.env.LLM_DAILY_CALL_BUDGET = String(DAILY_BUDGET);
    process.env.RATE_LIMIT_SEARCH_PER_MIN = '1000';
    process.env.RATE_LIMIT_SEARCH_PER_DAY = '10000';
    harness = await createApp();
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('A. blocks the third search of the day with a global RATE_LIMITED envelope', async () => {
    // Dois IPs distintos, os dois primeiros passam (AC2: o teto não é por cliente).
    await postSearch(harness.app, '10.0.0.1').expect(200);
    await postSearch(harness.app, '10.0.0.2').expect(200);

    const before = metricValue(
      (await get(harness.app, '/metrics').expect(200)).text,
      LLM_DISABLED_SERIES,
    );
    expect(Number.isInteger(before)).toBe(true);
    expect(before).toBe(2);

    // O terceiro IP não ganha orçamento novo: o contador é global, não por
    // `client_hash`.
    const blocked = await postSearch(harness.app, '10.0.0.3');

    expect(blocked.status).toBe(429);
    expect(blocked.body.request_id).toMatch(/^req_/);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.details).toEqual({
      scope: 'global',
      limit: DAILY_BUDGET,
      window_seconds: DAY_SECONDS,
    });
    // `Retry-After` em segundos e o mesmo número no corpo: no máximo um dia.
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(blocked.body.error.retry_after_seconds).toBe(Number(blocked.headers['retry-after']));
    expect(blocked.body.error.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.body.error.retry_after_seconds).toBeLessThanOrEqual(DAY_SECONDS);

    // A busca barrada não chega ao serviço: nada persiste e a LLM não é chamada.
    expect(harness.store.saved).toHaveLength(DAILY_BUDGET);
    const after = metricValue(
      (await get(harness.app, '/metrics').expect(200)).text,
      LLM_DISABLED_SERIES,
    );
    expect(after).toBe(before);
  }, 120_000);

  it('B. publishes rate_limited_total{scope="global"} on /metrics', async () => {
    const metrics = await get(harness.app, '/metrics').expect(200);

    expect(metrics.text).toContain(GLOBAL_RATE_LIMIT_SERIES);
    expect(metricValue(metrics.text, GLOBAL_RATE_LIMIT_SERIES)).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('the global budget rolls over at midnight UTC (#35)', () => {
  let harness: Harness;

  /** 23:59:30 UTC de 31/12: o `Retry-After` fica inequívoco (30 s). */
  const ROLLOVER_START = new Date('2026-12-31T23:59:30.000Z');

  beforeAll(async () => {
    harness = await createApp({ clock: new FakeClock(ROLLOVER_START) });
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('C. counts the retry from the injected clock and frees the quota on the next day', async () => {
    await postSearch(harness.app, '10.0.0.11').expect(200);
    await postSearch(harness.app, '10.0.0.12').expect(200);

    const blocked = await postSearch(harness.app, '10.0.0.13');
    expect(blocked.status).toBe(429);
    // Segundos até a meia-noite UTC do relógio injetado (30 s), nunca 86400.
    expect(blocked.body.error.retry_after_seconds).toBe(30);

    harness.clock.advance(31_000);

    // Dia novo, cota nova — mesmo processo, mesmo banco (em memória).
    await postSearch(harness.app, '10.0.0.14').expect(200);
    expect(harness.store.saved).toHaveLength(3);
    expect(harness.budget.calls.get('2027-01-01')).toBe(1);
  }, 120_000);
});

afterAll(() => {
  // O `setup.ts` só preenche o que está `undefined`; quem escreveu nas envs
  // devolve o valor original para o próximo arquivo e2e (roda com --runInBand).
  restoreEnv('LLM_DAILY_CALL_BUDGET', ORIGINAL_LIMITS.budget);
  restoreEnv('RATE_LIMIT_SEARCH_PER_MIN', ORIGINAL_LIMITS.min);
  restoreEnv('RATE_LIMIT_SEARCH_PER_DAY', ORIGINAL_LIMITS.day);
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
