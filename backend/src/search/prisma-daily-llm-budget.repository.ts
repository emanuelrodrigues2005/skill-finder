import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import type { DailyLlmBudgetStore } from './daily-llm-budget.port';

/**
 * Só o que a reserva usa do cliente Prisma.
 *
 * Estreitar o tipo (em vez de exigir `PrismaService`) deixa o teste de integração
 * passar o `PrismaClient` cru do banco de teste, sem cast e sem subir a app
 * inteira para provar uma instrução SQL.
 */
type RawQueryClient = Pick<PrismaService, '$queryRaw'>;

/**
 * Reserva do orçamento global diário em Postgres (issue #35).
 *
 * Uma instrução, não um `SELECT` seguido de `UPDATE`: entre a leitura e a
 * escrita, duas buscas simultâneas veriam a mesma cota livre e as duas passariam
 * — o teto valeria `n de requisições concorrentes` em vez do configurado. O
 * `ON CONFLICT DO UPDATE ... WHERE calls < teto` decide no banco, sob o lock da
 * linha do dia, e o `RETURNING` diz se esta chamada é a que entrou.
 */
@Injectable()
export class PrismaDailyLlmBudgetRepository implements DailyLlmBudgetStore {
  constructor(private readonly prisma: RawQueryClient) {}

  async tryReserve(day: string, limit: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ calls: number }>>`
      INSERT INTO "llm_daily_budget" ("day", "calls")
      VALUES (${day}::date, 1)
      ON CONFLICT ("day") DO UPDATE
         SET "calls" = "llm_daily_budget"."calls" + 1
       WHERE "llm_daily_budget"."calls" < ${limit}
      RETURNING "calls"
    `;
    // Sem linha de volta, o `WHERE` recusou a atualização: o dia está esgotado.
    return rows.length > 0;
  }
}
