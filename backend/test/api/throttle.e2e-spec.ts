/**
 * Issue #13 — rate limit **real** em `POST /api/v1/search` (decisões D1, D2 e D3).
 *
 * Hoje o `ThrottlerModule` existe no `app.module.ts` com os dois throttlers
 * nomeados (10/min e 60/dia) e nenhum guard: a rota não tem limite. Este spec é
 * o vermelho que prova isso e passa a valer quando o `coder` montar
 * `SearchThrottlerGuard` e o `@UseGuards` da rota.
 *
 * Casos:
 *   A. 30 POSTs seguidos: `[0,10)` é 200; `[10,30)` é 429 com o envelope de
 *      §5.5 (`RATE_LIMITED`, `details {limit, window_seconds}`,
 *      `retry_after_seconds` igual ao header `Retry-After`), sem a mensagem do
 *      `ThrottlerException` cru, e **`store.saved.length === 10`** — request
 *      bloqueado não chega ao serviço, logo não persiste.
 *   B. app com `PER_MIN=1000`, `PER_DAY=2`: o terceiro POST estoura a janela
 *      diária e o `details.window_seconds` prova que o teto é o de 86400 s.
 *   C. rajada de 30 GETs em `/healthz`, `/readyz` e `/metrics`: **todos 200**.
 *      Pina D1 (guard na rota, nunca `APP_GUARD` global): probe limitado faria o
 *      container reiniciar em loop.
 *   D. bucket por cliente (D2): esgotado o cliente default (`127.0.0.1`), um POST
 *      com `X-Forwarded-For: 10.0.0.7` responde 200 e o default continua 429.
 *   E/F. identidade (ADR-015): `X-Real-IP` forjado não muda o `client_hash`;
 *      quem manda é a última entrada do `X-Forwarded-For`, e sem header nenhum
 *      vale o `req.ip` do socket — estável entre requisições.
 *
 * `RATE_LIMIT_SEARCH_PER_MIN`/`PER_DAY` são lidas na **construção** do módulo
 * (`ThrottlerModule.forRootAsync` -> `AppConfigService`), por isso cada cenário
 * fixa as envs no `beforeAll`, antes do `Test.createTestingModule`. O
 * `test/setup.ts` só preenche o que está `undefined`: ele não restaura nada, e
 * com `--runInBand` os arquivos e2e compartilham o `process.env` — daí o
 * `afterAll` de topo devolvendo os valores originais.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import { AppConfigService } from '@/config/config.module';
import { configureApp } from '@/main';
import { PrismaService } from '@/prisma/prisma.service';
import { clientHash } from '@/search/client-hash';
import { decodeSkillId, encodeSkillId } from '@/search/ids';
import type {
  ListSkillsInput,
  SearchCatalog,
  SearchCatalogInput,
  SkillPage,
} from '@/search/search-catalog.port';
import type { SearchStore, StoredSearchInput, StoredSearchRow } from '@/search/search-store.port';
import { SEARCH_CATALOG, SEARCH_STORE } from '@/search/search.tokens';

// Configuração de teste de `test/setup.ts`; reforçada porque um `.env` local não
// pode mudar o cenário (mesma razão de `search.e2e-spec.ts`).
process.env.LLM_ENABLED = 'false';

const ORIGINAL_LIMITS = {
  min: process.env.RATE_LIMIT_SEARCH_PER_MIN,
  day: process.env.RATE_LIMIT_SEARCH_PER_DAY,
};

const HOUR_MS = 60 * 60 * 1000;
const QUERY = 'review pull requests for security problems in Python';
const MINUTE_LIMIT = 10;
/** Teto diário alto nos cenários que testam a janela de minuto (isola o alvo). */
const PER_DAY_HIGH = 60_000;

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
  {
    skill_id: encodeSkillId(43n),
    name: 'pr-hygiene',
    source_url: 'https://skills.sh/example/pr-hygiene',
    category: 'backend',
    stars: 300,
    installs: 2000,
    vulnerability_count: 0,
    security_status: 'ok',
    skill_md_present: false,
  },
];

const CATEGORIES: readonly CategoryItem[] = [
  { slug: 'backend', label_en: 'Backend', skill_count: 2 },
];

function freshSnapshot(): Date {
  return new Date(Date.now() - HOUR_MS / 60);
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

interface Harness {
  readonly app: INestApplication;
  readonly store: StoreStub;
}

async function createApp(): Promise<Harness> {
  const store = new StoreStub();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(new PrismaStub())
    .overrideProvider(SEARCH_CATALOG)
    .useValue(new CatalogStub())
    .overrideProvider(SEARCH_STORE)
    .useValue(store)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, store };
}

interface ClientHeaders {
  readonly realIp?: string;
  readonly forwardedFor?: string;
}

function postSearch(app: INestApplication, headers: ClientHeaders = {}): request.Test {
  const call = request(app.getHttpServer()).post('/api/v1/search').send({ query: QUERY });
  if (headers.realIp !== undefined) {
    call.set('X-Real-IP', headers.realIp);
  }
  if (headers.forwardedFor !== undefined) {
    call.set('X-Forwarded-For', headers.forwardedFor);
  }
  return call;
}

/** Asserções comuns de um 429 de §5.5 (D3), com o teto/janela do throttler. */
function expectRateLimited(
  response: request.Response,
  expected: { readonly limit: number; readonly window_seconds: number },
): void {
  expect(response.status).toBe(429);
  expect(response.body.request_id).toMatch(/^req_/);
  expect(response.body.error.code).toBe('RATE_LIMITED');
  expect(response.body.error.details).toEqual(expected);

  // Header e corpo dizem o mesmo, em segundos (nunca o `ttl` em ms).
  expect(response.headers['retry-after']).toMatch(/^\d+$/);
  const retryAfter = Number(response.headers['retry-after']);
  expect(Number.isInteger(response.body.error.retry_after_seconds)).toBe(true);
  expect(response.body.error.retry_after_seconds).toBe(retryAfter);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(expected.window_seconds);

  // A mensagem do `ThrottlerException` puro não é contrato de §5.5.
  expect(String(response.body.error.message).toLowerCase()).not.toContain('throttlerexception');
}

describe('POST /api/v1/search rate limit — minute window (D1, D3)', () => {
  let harness: Harness;

  beforeAll(async () => {
    // Lidas na construção do módulo: tem de ser antes do createTestingModule.
    process.env.RATE_LIMIT_SEARCH_PER_MIN = String(MINUTE_LIMIT);
    process.env.RATE_LIMIT_SEARCH_PER_DAY = String(PER_DAY_HIGH);
    harness = await createApp();
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('C. does not throttle the probes or /metrics (D1: route guard, not APP_GUARD)', async () => {
    for (const path of ['/healthz', '/readyz', '/metrics']) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const response = await request(harness.app.getHttpServer()).get(path);
        expect({ path, attempt, status: response.status }).toEqual({
          path,
          attempt,
          status: 200,
        });
      }
    }
  }, 120_000);

  it('A. answers 200 for the first 10 searches and 429 with Retry-After afterwards', async () => {
    const responses: request.Response[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      responses.push(await postSearch(harness.app));
    }

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(MINUTE_LIMIT);
    expect(statuses.filter((status) => status === 429)).toHaveLength(30 - MINUTE_LIMIT);
    expect(statuses.slice(0, MINUTE_LIMIT)).toEqual(new Array<number>(MINUTE_LIMIT).fill(200));
    expect(statuses.slice(MINUTE_LIMIT)).toEqual(new Array<number>(30 - MINUTE_LIMIT).fill(429));

    const successful = responses[0];
    expect(successful?.body.results).toHaveLength(2);

    const blocked = responses.slice(MINUTE_LIMIT);
    for (const response of blocked) {
      expectRateLimited(response, { limit: MINUTE_LIMIT, window_seconds: 60 });
    }

    // O bloqueio acontece no guard, antes do controller: busca barrada não persiste.
    expect(harness.store.saved).toHaveLength(MINUTE_LIMIT);
  }, 120_000);
});

describe('POST /api/v1/search rate limit — daily window (D3)', () => {
  let harness: Harness;

  beforeAll(async () => {
    process.env.RATE_LIMIT_SEARCH_PER_MIN = '1000';
    process.env.RATE_LIMIT_SEARCH_PER_DAY = '2';
    harness = await createApp();
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('B. the third search is blocked by the daily throttler (window 86400)', async () => {
    await postSearch(harness.app).expect(200);
    await postSearch(harness.app).expect(200);

    const blocked = await postSearch(harness.app);

    expectRateLimited(blocked, { limit: 2, window_seconds: 86_400 });
    expect(harness.store.saved).toHaveLength(2);
  }, 120_000);
});

describe('POST /api/v1/search rate limit — per client (D2)', () => {
  let harness: Harness;

  beforeAll(async () => {
    process.env.RATE_LIMIT_SEARCH_PER_MIN = String(MINUTE_LIMIT);
    process.env.RATE_LIMIT_SEARCH_PER_DAY = String(PER_DAY_HIGH);
    harness = await createApp();
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('D. keys the bucket by client: a new X-Forwarded-For is not blocked with the exhausted one', async () => {
    // Esgota o cliente default (`127.0.0.1`, sem header): 10 passam, o 11º não.
    for (let attempt = 0; attempt < MINUTE_LIMIT; attempt += 1) {
      await postSearch(harness.app).expect(200);
    }
    const exhausted = await postSearch(harness.app);
    expectRateLimited(exhausted, { limit: MINUTE_LIMIT, window_seconds: 60 });

    // D2: outro cliente tem bucket próprio — o IP vem de `req.ip`, que com
    // `trust proxy = 1` é a entrada do `X-Forwarded-For` que a borda anexou.
    const other = await postSearch(harness.app, { forwardedFor: '10.0.0.7' });
    expect(other.status).toBe(200);
    expect(harness.store.saved).toHaveLength(MINUTE_LIMIT + 1);

    // E o cliente esgotado continua bloqueado (o bucket do outro não o liberou).
    const stillBlocked = await postSearch(harness.app);
    expectRateLimited(stillBlocked, { limit: MINUTE_LIMIT, window_seconds: 60 });
  }, 120_000);
});

describe('POST /api/v1/search — client identity (ADR-015)', () => {
  let harness: Harness;
  let salt: string | undefined;

  const FORWARDED = '9.9.9.9, 200.10.20.30';
  /** O que o cliente do último POST persistiu no histórico. */
  function lastClientHash(): string {
    const row = harness.store.saved[harness.store.saved.length - 1];
    if (row === undefined) {
      throw new Error('nenhuma busca persistida');
    }
    return row.client_hash;
  }

  beforeAll(async () => {
    // Teto alto: aqui o alvo é a identidade, não o 429.
    process.env.RATE_LIMIT_SEARCH_PER_MIN = '1000';
    process.env.RATE_LIMIT_SEARCH_PER_DAY = String(PER_DAY_HIGH);
    harness = await createApp();
    salt = harness.app.get(AppConfigService).env.ipHashSalt;
  }, 120_000);

  afterAll(async () => {
    await harness.app.close();
  });

  it('E. a forged X-Real-IP does not change the client_hash the bucket is keyed by', async () => {
    // O cliente manda `X-Real-IP: 1.2.3.4` e um `X-Forwarded-For` forjado; o ALB
    // anexa o IP real ao fim da lista (modo `append`, ADR-015).
    await postSearch(harness.app, { realIp: '1.2.3.4', forwardedFor: FORWARDED }).expect(200);
    const forged = lastClientHash();

    await postSearch(harness.app, { forwardedFor: FORWARDED }).expect(200);
    const plain = lastClientHash();

    // O `client_hash` é a chave do bucket: hash igual = bucket igual.
    expect(forged).toBe(plain);
    // Quem manda é a ÚLTIMA entrada do XFF (a que o ALB anexou), nunca a
    // primeira (forjada pelo cliente) nem o `X-Real-IP`.
    expect(forged).toBe(clientHash('200.10.20.30', salt));
    expect(forged).not.toBe(clientHash('9.9.9.9', salt));
    expect(forged).not.toBe(clientHash('1.2.3.4', salt));
  }, 120_000);

  it('F. without any header (direct dev access) the identity is `req.ip`, stable across requests', async () => {
    await postSearch(harness.app).expect(200);
    const first = lastClientHash();
    await postSearch(harness.app).expect(200);
    const second = lastClientHash();

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // E é o IP do socket, não um header: o valor do XFF de E não vaza para cá.
    expect(first).not.toBe(clientHash('200.10.20.30', salt));
  }, 120_000);
});

afterAll(() => {
  // O `setup.ts` só preenche o que está `undefined`; quem escreveu nas envs
  // devolve o valor original para o próximo arquivo e2e (roda com --runInBand).
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
