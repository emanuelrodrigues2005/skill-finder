/**
 * Issue #35 — o orçamento **global** diário de chamadas da LLM, na unidade.
 *
 * Três regras que o e2e não isola e este spec fixa:
 *
 * 1. **sem `LLM_DAILY_CALL_BUDGET` nada muda** — nem consulta ao banco, nem
 *    recusa. É a compatibilidade exigida: o teto é opt-in;
 * 2. **a decisão é do dia do calendário UTC**, e quem dá o dia é o relógio
 *    injetado (`FakeClock`), não `new Date()` espalhado — a virada é provada
 *    avançando o relógio, não esperando 24 h;
 * 3. **a métrica conta a recusa, não o volume**: `rate_limited_total{scope}`
 *    incrementa uma vez por busca barrada e nenhuma vez numa busca que coube no
 *    orçamento.
 *
 * O adaptador Postgres (a reserva atômica) não é objeto deste arquivo: ele só
 * tem como fonte de verdade o banco real, em
 * `test/integration/search-budget.spec.ts`.
 */
import type { MetricsService } from '@/common/metrics/metrics.service';
import type { AppConfigService } from '@/config/config.module';
import { loadEnv } from '@/config/env.schema';
import { systemClock, type Clock } from '@/search/clock';
import { DailyLlmBudget } from '@/search/daily-llm-budget.service';
import type { DailyLlmBudgetStore } from '@/search/daily-llm-budget.port';

const DAY_SECONDS = 86_400;

/** Meia-noite UTC de 31/12/2026, instante em que a cota do ano vira. */
const YEAR_END = new Date('2026-12-31T23:59:30.000Z');

/** Config validada de dev, com o teto do cenário (`undefined` = sem teto). */
function appConfig(dailyBudget: number | undefined): AppConfigService {
  return {
    env: { ...loadEnv({ ENV: 'dev' }), llmDailyCallBudget: dailyBudget },
    isProd: false,
  };
}

/** Cota em memória com a mesma regra do adaptador: `calls < limit`. */
class RecordingStore implements DailyLlmBudgetStore {
  readonly reservations: Array<{ day: string; limit: number }> = [];
  private readonly calls = new Map<string, number>();

  tryReserve(day: string, limit: number): Promise<boolean> {
    this.reservations.push({ day, limit });
    const used = this.calls.get(day) ?? 0;
    if (used >= limit) {
      return Promise.resolve(false);
    }
    this.calls.set(day, used + 1);
    return Promise.resolve(true);
  }

  days(): string[] {
    return this.reservations.map((reservation) => reservation.day);
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

interface RecordedMetrics {
  readonly scopes: string[];
}

function metricsRecorder(): { metrics: MetricsService; recorded: RecordedMetrics } {
  const scopes: string[] = [];
  const metrics = {
    observeRateLimited: (scope: string): void => {
      scopes.push(scope);
    },
  } as unknown as MetricsService;
  return { metrics, recorded: { scopes } };
}

function budgetOf(
  limit: number | undefined,
  clock: Clock = systemClock,
  store: RecordingStore = new RecordingStore(),
): { budget: DailyLlmBudget; store: RecordingStore; recorded: RecordedMetrics } {
  const { metrics, recorded } = metricsRecorder();
  return { budget: new DailyLlmBudget(store, appConfig(limit), clock, metrics), store, recorded };
}

describe('DailyLlmBudget (#35)', () => {
  it('A. without LLM_DAILY_CALL_BUDGET neither reserves nor refuses (compatibilidade)', async () => {
    const { budget, store, recorded } = budgetOf(undefined);

    await expect(budget.reserve()).resolves.toBeNull();
    await expect(budget.reserve()).resolves.toBeNull();

    // Sem teto configurado, o banco não é consultado: o comportamento é o de
    // antes da issue, mesmo com a LLM habilitada.
    expect(store.reservations).toEqual([]);
    expect(recorded.scopes).toEqual([]);
  });

  it('B. allows up to the limit and refuses the next call with the day rejection', async () => {
    const clock = new FakeClock(new Date('2026-11-23T23:30:00.000Z'));
    const { budget, store, recorded } = budgetOf(2, clock);

    await expect(budget.reserve()).resolves.toBeNull();
    await expect(budget.reserve()).resolves.toBeNull();

    const rejection = await budget.reserve();

    // 30 min até a meia-noite UTC: o retry sai do relógio, nunca de 86400 fixo.
    expect(rejection).toEqual({
      limit: 2,
      windowSeconds: DAY_SECONDS,
      retryAfterSeconds: 1_800,
    });
    // A chamada recusada não consome cota: o dia continua com 2, não com 3.
    expect(store.days()).toEqual(['2026-11-23', '2026-11-23', '2026-11-23']);
    expect(recorded.scopes).toEqual(['global']);
  });

  it('C. frees the quota on the next UTC day, keyed by the injected clock', async () => {
    const clock = new FakeClock(YEAR_END);
    const { budget, store } = budgetOf(1, clock);

    await expect(budget.reserve()).resolves.toBeNull();

    const rejection = await budget.reserve();
    expect(rejection?.retryAfterSeconds).toBe(30);

    clock.advance(31_000);

    await expect(budget.reserve()).resolves.toBeNull();
    expect(store.days()).toEqual(['2026-12-31', '2026-12-31', '2027-01-01']);
  });
});
