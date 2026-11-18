/**
 * Issue #45 — rodízio do catálogo: a escolha dos 720 slots do ciclo.
 *
 * Ratificado em F2.10 (D3): catálogo de 20.000, ciclo de 6 h, 720 skills por
 * ciclo, hot set = `search_request.result_ids` dos últimos 7 dias limitado a 360
 * slots, cold = o resto, girando em 7–14 dias.
 *
 * O que este spec prova, sem banco:
 *
 * - a **fusão** é determinística: mesma entrada ⇒ mesma saída, sem relógio
 *   implícito (o `now` entra por parâmetro) e sem `Math.random`;
 * - o hot vem primeiro, ordenado pela requisição mais recente e com
 *   `source_key ASC` como desempate;
 * - o cold vem depois, das linhas vencidas (TTL de 14 d) para as mais antigas,
 *   também com `source_key ASC` como desempate;
 * - chave repetida entre hot e cold aparece **uma vez**, na posição do hot;
 * - o ciclo respeita `cycleSlots` mesmo quando `hotSlots` é maior que ele.
 *
 * A consulta em si (SQL com `unnest` de `result_ids` e o índice
 * `(is_active, last_seen_at)`) é provada com Postgres de verdade em
 * `test/integration/catalog-rotation.spec.ts`.
 */
import type { PrismaClient } from '@prisma/client';

import type { RotationCandidate, RotationParams } from '@/catalog/prisma-catalog.repository';
import { PrismaCatalogRepository, mergeRotationKeys } from '@/catalog/prisma-catalog.repository';

const NOW = new Date('2026-11-18T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Parâmetros ratificados da issue; o `now` é explícito de propósito. */
function params(overrides: Partial<RotationParams> = {}): RotationParams {
  return {
    now: NOW,
    hotSlots: 360,
    coldMinDays: 7,
    coldMaxDays: 14,
    cycleSlots: 720,
    ...overrides,
  };
}

function hotCandidate(sourceKey: string, requestedHoursAgo: number): RotationCandidate {
  return {
    sourceKey,
    requestedAt: new Date(NOW.getTime() - requestedHoursAgo * HOUR),
    lastSeenAt: new Date(NOW.getTime() - requestedHoursAgo * HOUR),
  };
}

function coldCandidate(sourceKey: string, seenDaysAgo: number): RotationCandidate {
  return {
    sourceKey,
    requestedAt: null,
    lastSeenAt: new Date(NOW.getTime() - seenDaysAgo * DAY),
  };
}

interface Pool {
  hot: RotationCandidate[];
  cold: RotationCandidate[];
}

/** Conjunto misto: hot com empate de horário e cold vencido, velho e recente. */
function mixedPool(): Pool {
  return {
    hot: [
      hotCandidate('hot/older', 30),
      hotCandidate('hot/newer', 2),
      // Mesmo instante de requisição: quem decide é `source_key ASC`.
      hotCandidate('hot/tie-bravo', 10),
      hotCandidate('hot/tie-alpha', 10),
    ],
    cold: [
      coldCandidate('cold/recent', 8),
      // Vencida (TTL de 14 d) tem de vir antes das frias ainda válidas.
      coldCandidate('cold/expired', 20),
      coldCandidate('cold/older', 12),
    ],
  };
}

describe('mergeRotationKeys — rotation do catálogo', () => {
  it('puts the hot set first, by recency, with source_key ASC as the tiebreak', () => {
    const keys = mergeRotationKeys(params({ hotSlots: 4, cycleSlots: 4 }), mixedPool());

    expect(keys).toEqual(['hot/newer', 'hot/tie-alpha', 'hot/tie-bravo', 'hot/older']);
  });

  it('continues with the cold set, expired rows first, then the oldest', () => {
    const keys = mergeRotationKeys(params({ hotSlots: 0, cycleSlots: 3 }), mixedPool());

    expect(keys).toEqual(['cold/expired', 'cold/older', 'cold/recent']);
  });

  it('returns at most 720 distinct keys with the hot set first and no key repeated', () => {
    const hot = Array.from({ length: 400 }, (_unused, index) =>
      hotCandidate(`hot/skill-${String(index).padStart(4, '0')}`, index),
    );
    const cold = Array.from({ length: 500 }, (_unused, index) =>
      coldCandidate(`cold/skill-${String(index).padStart(4, '0')}`, 7 + (index % 7)),
    );

    const keys = mergeRotationKeys(params(), { hot, cold });

    expect(keys).toHaveLength(720);
    expect(new Set(keys).size).toBe(720);
    // 360 slots do hot set, na ordem de recência (índice 0 é o mais recente).
    expect(keys.slice(0, 360)).toEqual(hot.slice(0, 360).map((item) => item.sourceKey));
    // O resto vem do cold: nenhuma chave do hot aparece depois.
    expect(keys.slice(360).every((key) => key.startsWith('cold/'))).toBe(true);
  });

  it('keeps a key that the cold set repeats once, at its hot position', () => {
    const pool: Pool = {
      hot: [hotCandidate('acme/toolbox/same', 1)],
      cold: [coldCandidate('acme/toolbox/same', 9), coldCandidate('acme/toolbox/other', 10)],
    };

    const keys = mergeRotationKeys(params({ hotSlots: 1, cycleSlots: 10 }), pool);

    expect(keys).toEqual(['acme/toolbox/same', 'acme/toolbox/other']);
    expect(keys.filter((key) => key === 'acme/toolbox/same')).toHaveLength(1);
  });

  it('caps the cycle at cycleSlots even when hotSlots is larger', () => {
    const pool: Pool = {
      hot: [
        hotCandidate('hot/a', 1),
        hotCandidate('hot/b', 2),
        hotCandidate('hot/c', 3),
        hotCandidate('hot/d', 4),
      ],
      cold: [coldCandidate('cold/a', 9)],
    };

    expect(mergeRotationKeys(params({ hotSlots: 720, cycleSlots: 2 }), pool)).toEqual([
      'hot/a',
      'hot/b',
    ]);
  });

  it('does not care about the input order of either pool (deterministic)', () => {
    const pool = mixedPool();
    const shuffled: Pool = { hot: [...pool.hot].reverse(), cold: [...pool.cold].reverse() };
    const options = params({ hotSlots: 3, cycleSlots: 5 });

    expect(mergeRotationKeys(options, shuffled)).toEqual(mergeRotationKeys(options, pool));
  });

  it('answers an empty list for an empty catalog', () => {
    expect(mergeRotationKeys(params(), { hot: [], cold: [] })).toEqual([]);
  });

  it('answers an empty list when the cycle has no slots', () => {
    expect(mergeRotationKeys(params({ cycleSlots: 0 }), mixedPool())).toEqual([]);
  });
});

/** Duplo do `PrismaClient`: registra o SQL e devolve uma fila de respostas. */
interface RecordedCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

class FakePrisma {
  readonly calls: RecordedCall[] = [];
  readonly responses: unknown[][] = [];

  readonly $queryRaw = (first: unknown, ...rest: unknown[]): Promise<unknown[]> => {
    const sql = Array.isArray(first) ? (first as string[]).join('?') : String(first);
    this.calls.push({ sql, values: rest });
    return Promise.resolve(this.responses.shift() ?? []);
  };
}

function repository(): { prisma: FakePrisma; repo: PrismaCatalogRepository } {
  const prisma = new FakePrisma();
  return { prisma, repo: new PrismaCatalogRepository(prisma as unknown as PrismaClient) };
}

describe('PrismaCatalogRepository — rotation keys', () => {
  it('reads the hot set from the last 7 days of result_ids and the cold set after it', async () => {
    const { prisma, repo } = repository();
    prisma.responses.push(
      [
        { source_key: 'hot/b', requested_at: new Date(NOW.getTime() - HOUR), last_seen_at: NOW },
        { source_key: 'hot/a', requested_at: new Date(NOW.getTime() - HOUR), last_seen_at: NOW },
      ],
      [{ source_key: 'cold/a', last_seen_at: new Date(NOW.getTime() - 10 * DAY) }],
    );

    const keys = await repo.selectRotationKeys(params({ hotSlots: 2 }));

    expect(keys).toEqual(['hot/a', 'hot/b', 'cold/a']);
    expect(prisma.calls).toHaveLength(2);

    const hot = prisma.calls[0];
    expect(hot?.sql).toContain('"search_request"');
    expect(hot?.sql).toContain('unnest');
    // Janela do hot set: 7 dias antes do `now` injetado, nunca `now()` do banco.
    expect(hot?.values).toEqual([new Date(NOW.getTime() - 7 * DAY), 2]);

    const cold = prisma.calls[1];
    expect(cold?.sql).toContain('FROM "skill"');
    expect(cold?.sql).toContain('is_active = true');
    // `source_key ASC` em collation C: a mesma ordem do `sourceKey` do TS.
    expect(cold?.sql).toContain('COLLATE "C"');
  });

  it('skips the cold query when the hot set already fills the cycle', async () => {
    const { prisma, repo } = repository();
    prisma.responses.push([
      { source_key: 'hot/a', requested_at: NOW, last_seen_at: NOW },
      { source_key: 'hot/b', requested_at: NOW, last_seen_at: NOW },
    ]);

    const keys = await repo.selectRotationKeys(params({ hotSlots: 2, cycleSlots: 2 }));

    expect(keys).toEqual(['hot/a', 'hot/b']);
    expect(prisma.calls).toHaveLength(1);
  });

  it('answers an empty list for an empty catalog', async () => {
    const { prisma, repo } = repository();

    expect(await repo.selectRotationKeys(params())).toEqual([]);
    // Sem hot, o cold ainda é consultado: é ele que preenche os 720 slots.
    expect(prisma.calls).toHaveLength(2);
  });
});
