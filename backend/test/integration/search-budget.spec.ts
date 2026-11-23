/**
 * Issue #35 — o orçamento global diário contra **Postgres real**.
 *
 * O e2e (`test/api/search-budget.e2e-spec.ts`) prova o contrato HTTP com o
 * armazenamento em memória. O que só o banco prova é o que a issue exige:
 *
 * 1. **reinício não devolve a cota no mesmo dia** — a aplicação é fechada e outra
 *    sobe com módulos, `PrismaClient` e registry de métricas novos; a linha do
 *    dia é a única coisa que sobrevive, e a primeira busca da app nova já é 429.
 *    A métrica da app nova começa em zero, o que mostra que a recusa veio do
 *    banco e não de um contador em memória;
 * 2. **a reserva é atômica e condicional** — `INSERT ... ON CONFLICT DO UPDATE
 *    ... WHERE calls < teto` decide numa instrução, e a tentativa recusada **não**
 *    incrementa `calls` (senão a cota encolheria a cada busca barrada);
 * 3. a reserva é por **dia UTC**: dias diferentes são linhas diferentes.
 *
 * Nenhum socket externo: `127.0.0.1:55432` é o container de `make db-test-up` e
 * `assertDatabase` falha (não pula) quando ele não está no ar.
 */
import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { createFixtureSource } from '@/catalog/fixture-source';
import { ingest } from '@/catalog/ingest';
import { PrismaCatalogRepository } from '@/catalog/prisma-catalog.repository';
import { configureApp } from '@/main';
import { CLOCK, type Clock } from '@/search/clock';
import { PrismaDailyLlmBudgetRepository } from '@/search/prisma-daily-llm-budget.repository';

import { assertDatabase, createTestPrismaClient, truncateAll } from './db';
import {
  lockTestDatabase,
  serializedTestDatabaseUrl,
  unlockTestDatabase,
} from './serial';

/** Teto do cenário: duas buscas cabem, a terceira já é do dia seguinte. */
const DAILY_BUDGET = 2;

const QUERY = 'testing';
const GLOBAL_RATE_LIMIT_SERIES = 'rate_limited_total{scope="global"}';

/** 23:59:30 UTC de 31/12/2026: a virada do dia é do relógio, não da espera. */
const YEAR_END = new Date('2026-12-31T23:59:30.000Z');

const ORIGINAL_BUDGET = process.env.LLM_DAILY_CALL_BUDGET;

/**
 * Relógio controlado: a virada do dia é do teste. Precisa existir antes do
 * `compile()`, porque o provedor é resolvido junto com o módulo.
 */
class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

interface RunningApp {
  readonly app: INestApplication;
}

/**
 * Sobe a aplicação inteira, como em produção: `AppModule` sem `overrideProvider`
 * das portas — catálogo, histórico e orçamento são os adaptadores reais,
 * apontados para o banco de teste por `setup-env.ts`. `LLM_ENABLED=false` mantém
 * o provedor fora do caminho (regra 5).
 */
async function startApp(clock: FakeClock): Promise<RunningApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  await app.listen(0);
  return { app };
}

/** Valor de uma série de `/metrics`; `NaN` quando ela não existe. */
function metricValue(text: string, series: string): number {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${series} `));
  return line === undefined ? Number.NaN : Number(line.slice(series.length + 1));
}

describe('global daily LLM budget over real Postgres (#35)', () => {
  let prisma: PrismaClient;
  let locked = false;

  /** Ingestão da fixture: `POST /search` precisa de snapshot e de categoria. */
  async function ingestFixture(): Promise<void> {
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    await ingest({
      source: createFixtureSource(),
      repository: new PrismaCatalogRepository(prisma),
      adapter: 'fixture',
      startedAt,
      now: () => startedAt,
    });
  }

  function postSearch(app: INestApplication): request.Test {
    return request(app.getHttpServer() as Server)
      .post('/api/v1/search')
      .send({ query: QUERY });
  }

  function get(app: INestApplication, path: string): request.Test {
    return request(app.getHttpServer() as Server).get(path);
  }

  async function usageRow(day: string): Promise<{ calls: number } | null> {
    const rows = await prisma.$queryRaw<Array<{ calls: number }>>`
      SELECT calls FROM "llm_daily_budget" WHERE day = ${day}::date
    `;
    return rows[0] ?? null;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient(serializedTestDatabaseUrl());
    await assertDatabase(prisma);
    await lockTestDatabase(prisma);
    locked = true;
  }, 120_000);

  afterAll(async () => {
    restoreEnv('LLM_DAILY_CALL_BUDGET', ORIGINAL_BUDGET);
    if (locked) {
      await unlockTestDatabase(prisma);
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    process.env.LLM_DAILY_CALL_BUDGET = String(DAILY_BUDGET);
  });

  it(
    'keeps the day budget after the app restarts on the same day (AC3)',
    async () => {
      await ingestFixture();

      const first = await startApp(new FakeClock(YEAR_END));
      try {
        await postSearch(first.app).expect(200);
        await postSearch(first.app).expect(200);
        expect((await postSearch(first.app)).status).toBe(429);
      } finally {
        await first.app.close();
      }

      // "Reinício": módulos, `PrismaClient` e registry de métricas novos. O único
      // estado que atravessa é a linha de `llm_daily_budget`.
      const second = await startApp(new FakeClock(new Date(YEAR_END.getTime() + 10_000)));
      try {
        const freshMetrics = await get(second.app, '/metrics').expect(200);
        // O contador da app nova nasce em zero: se o 429 abaixo vier, ele veio do
        // banco, não de memória.
        expect(metricValue(freshMetrics.text, GLOBAL_RATE_LIMIT_SERIES)).toBe(0);

        const blocked = await postSearch(second.app);

        expect(blocked.status).toBe(429);
        expect(blocked.body.error.code).toBe('RATE_LIMITED');
        expect(blocked.body.error.details).toEqual({
          scope: 'global',
          limit: DAILY_BUDGET,
          window_seconds: 86_400,
        });
        // 23:59:30 + 10 s: 20 s até a meia-noite UTC, ou seja, **mesmo dia**.
        expect(blocked.body.error.retry_after_seconds).toBe(20);

        const afterMetrics = await get(second.app, '/metrics').expect(200);
        expect(metricValue(afterMetrics.text, GLOBAL_RATE_LIMIT_SERIES)).toBe(1);
      } finally {
        await second.app.close();
      }

      // O dia gastou exatamente o teto: a tentativa barrada não consumiu cota.
      expect(await usageRow('2026-12-31')).toEqual({ calls: DAILY_BUDGET });
      expect(await usageRow('2027-01-01')).toBeNull();
    },
    180_000,
  );

  it(
    'gives the next UTC day a fresh quota',
    async () => {
      await ingestFixture();

      const clock = new FakeClock(YEAR_END);
      const { app } = await startApp(clock);
      try {
        await postSearch(app).expect(200);
        await postSearch(app).expect(200);
        expect((await postSearch(app)).status).toBe(429);

        clock.advance(31_000);

        // Mesmo processo e mesmo banco: o dia novo é uma linha nova.
        await postSearch(app).expect(200);

        expect(await usageRow('2026-12-31')).toEqual({ calls: DAILY_BUDGET });
        expect(await usageRow('2027-01-01')).toEqual({ calls: 1 });
      } finally {
        await app.close();
      }
    },
    180_000,
  );

  it(
    'the adapter refuses over the limit without consuming quota',
    async () => {
      const store = new PrismaDailyLlmBudgetRepository(prisma);

      await expect(store.tryReserve('2026-11-23', DAILY_BUDGET)).resolves.toBe(true);
      await expect(store.tryReserve('2026-11-23', DAILY_BUDGET)).resolves.toBe(true);
      // Terceira e quarta: recusadas e **sem** incrementar (`WHERE calls < teto`).
      await expect(store.tryReserve('2026-11-23', DAILY_BUDGET)).resolves.toBe(false);
      await expect(store.tryReserve('2026-11-23', DAILY_BUDGET)).resolves.toBe(false);

      expect(await usageRow('2026-11-23')).toEqual({ calls: DAILY_BUDGET });

      // Outro dia é outra linha — e outra cota.
      await expect(store.tryReserve('2026-11-24', DAILY_BUDGET)).resolves.toBe(true);
      expect(await usageRow('2026-11-24')).toEqual({ calls: 1 });
    },
    60_000,
  );
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
