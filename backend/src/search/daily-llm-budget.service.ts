/**
 * Orçamento **global** diário de chamadas da LLM (issue #35).
 *
 * Por que global e não por cliente: o rate limit de `search-throttler.guard.ts`
 * tem a chave no `client_hash`, então trocar de IP compra um bucket novo e o teto
 * real é `n de IPs x RATE_LIMIT_SEARCH_PER_DAY`. O crédito e a chave do provedor
 * são um só, e é isso que este teto protege — a contagem não pode ser por cliente.
 *
 * Por que persistir: a cota vale até a meia-noite UTC, sobrevive a reinício do
 * container e a mais de uma réplica. Guardá-la em memória devolveria o orçamento
 * inteiro a cada deploy e dobraria o gasto com dois processos.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';

import { MetricsService } from '../common/metrics/metrics.service';
import { AppConfigService } from '../config/config.module';

import { CLOCK, type Clock } from './clock';
import type { DailyLlmBudgetStore } from './daily-llm-budget.port';
import { DAILY_LLM_BUDGET_STORE } from './search.tokens';

/** Janela do dia do calendário, em segundos (é o `window_seconds` do 429). */
const DAY_SECONDS = 86_400;

/** Recusa do orçamento: o que o 429 precisa publicar para o cliente reagir. */
export interface BudgetRejection {
  /** Teto diário configurado (`LLM_DAILY_CALL_BUDGET`). */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Segundos até a próxima meia-noite UTC, quando a cota volta. */
  readonly retryAfterSeconds: number;
}

@Injectable()
export class DailyLlmBudget {
  constructor(
    @Inject(DAILY_LLM_BUDGET_STORE) private readonly store: DailyLlmBudgetStore,
    private readonly config: AppConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    // Opcional de propósito: a métrica é observabilidade, não requisito da busca.
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  /**
   * Reserva uma chamada de LLM no dia corrente.
   *
   * `null` quando `LLM_DAILY_CALL_BUDGET` está ausente: sem teto configurado o
   * comportamento é o anterior à issue #35 — nenhuma escrita no banco e nenhuma
   * recusa, mesmo com o provedor habilitado.
   *
   * @returns `null` quando a chamada cabe no orçamento; a recusa (com o que o
   *   429 publica) quando o dia já gastou o teto.
   */
  async reserve(): Promise<BudgetRejection | null> {
    const limit = this.config.env.llmDailyCallBudget;
    if (limit === undefined) {
      return null;
    }

    const now = this.clock.now();
    if (await this.store.tryReserve(utcDay(now), limit)) {
      return null;
    }

    this.metrics?.observeRateLimited('global');
    return {
      limit,
      windowSeconds: DAY_SECONDS,
      retryAfterSeconds: secondsUntilNextUtcDay(now),
    };
  }
}

/** Dia do calendário em UTC (`YYYY-MM-DD`), a chave da cota. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Segundos até a próxima meia-noite UTC.
 *
 * Piso de 1 s: no instante exato da virada o `Retry-After: 0` mandaria o cliente
 * repetir antes de a cota existir.
 */
function secondsUntilNextUtcDay(now: Date): number {
  const nextDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextDay - now.getTime()) / 1000));
}
