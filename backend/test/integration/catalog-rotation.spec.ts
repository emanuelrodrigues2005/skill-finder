/**
 * Issue #45 — rodízio do catálogo contra **Postgres de verdade**.
 *
 * O spec unitário (`test/unit/catalog-prisma-repository-rotation.spec.ts`) prova
 * a fusão pura. Aqui o que se prova é o que só o banco sabe:
 *
 * - o hot set sai de `search_request.result_ids` dos últimos 7 dias, sem
 *   índice novo em `search_request` e sem repetir chave (o `unnest` do array é
 *   agrupado por `source_key`);
 * - a ordem do hot é a requisição mais recente; o cold gira das linhas vencidas
 *   (TTL de 14 d) para as mais antigas, com `source_key` como desempate;
 * - `cycleSlots`/`hotSlots` cortam de fato a resposta;
 * - a migration da #45 existe nos dois lados: coluna `ingest_run.items_requested`
 *   e índice `(is_active, last_seen_at)` em `skill`;
 * - `deactivateSkillsStaleBefore(cutoff)` desativa só o que passou do corte.
 *
 * O banco é o descartável da 55432 (`make db-test-up`), com a trava de advisory
 * lock de `serial.ts` — nenhum teste abre socket externo.
 */
import type { PrismaClient } from '@prisma/client';

import { PrismaCatalogRepository } from '@/catalog/prisma-catalog.repository';
import type { RotationParams } from '@/catalog/catalog-repository';

import { assertDatabase, createTestPrismaClient, truncateAll } from './db';
import { lockTestDatabase, serializedTestDatabaseUrl, unlockTestDatabase } from './serial';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Relógio injetado: `now` é parâmetro, nunca `new Date()` dentro da consulta. */
const NOW = new Date('2026-11-18T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY);
}

/** Parâmetros ratificados (D3); cada caso ajusta só o que precisa. */
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

interface SkillInput {
  readonly key: string;
  /** Idade de `last_seen_at`, em dias. */
  readonly seenDaysAgo: number;
  readonly isActive?: boolean;
}

describe('rotation over real Postgres (#45, rotation)', () => {
  let prisma: PrismaClient;
  let repository: PrismaCatalogRepository;
  /** `true` só depois do advisory lock: o `afterAll` não solta o que não pegou. */
  let locked = false;
  /** Contador de buscas: `request_id` é único, e nada aqui pode ser aleatório. */
  let searches = 0;

  beforeAll(async () => {
    prisma = createTestPrismaClient(serializedTestDatabaseUrl());
    repository = new PrismaCatalogRepository(prisma);
    await assertDatabase(prisma);
    await lockTestDatabase(prisma);
    locked = true;
  }, 120_000);

  beforeEach(async () => {
    searches = 0;
    await truncateAll(prisma);
  });

  afterAll(async () => {
    if (locked) {
      await unlockTestDatabase(prisma);
    }
    await prisma.$disconnect();
  });

  /** Insere a skill e devolve o id, que é o que `result_ids` guarda. */
  async function seedSkill(input: SkillInput): Promise<bigint> {
    const row = await prisma.skill.create({
      data: {
        sourceKey: input.key,
        name: input.key,
        firstSeenAt: daysAgo(60),
        lastSeenAt: daysAgo(input.seenDaysAgo),
        isActive: input.isActive ?? true,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Uma busca que devolveu estas skills no instante dado. */
  async function seedSearch(resultIds: bigint[], hoursAgo: number): Promise<void> {
    searches += 1;
    await prisma.searchRequest.create({
      data: {
        requestId: `req_${String(searches).padStart(6, '0')}`,
        clientHash: 'hash-cliente',
        queryHash: 'hash-consulta',
        createdAt: new Date(NOW.getTime() - hoursAgo * HOUR),
        resultIds,
        status: 'ok',
      },
    });
  }

  it('takes the hot set from the last 7 days of result_ids, most recent first', async () => {
    const alpha = await seedSkill({ key: 'acme/toolbox/alpha', seenDaysAgo: 8 });
    const bravo = await seedSkill({ key: 'acme/toolbox/bravo', seenDaysAgo: 30 });
    const charlie = await seedSkill({ key: 'acme/toolbox/charlie', seenDaysAgo: 9 });

    // Só a busca de 2 h atrás está dentro da janela de 7 dias.
    await seedSearch([bravo], 2);
    // Busca de 8 dias: fora da janela, não pode promover ninguém a hot.
    await seedSearch([alpha], 8 * 24);
    await seedSearch([charlie, bravo], 30);

    const bands = await repository.selectRotationKeys(params({ cycleSlots: 3 }));

    expect(bands.hot[0]).toBe('acme/toolbox/bravo');
    // A mesma chave em duas buscas conta uma vez.
    expect(bands.hot.filter((key) => key === 'acme/toolbox/bravo')).toHaveLength(1);
    // `alpha` não está no hot (busca fora da janela): entra pelo cold.
    expect(bands.cold).toEqual(['acme/toolbox/alpha']);
  });

  it('keeps the hot ordering by recency and the source_key tiebreak', async () => {
    const older = await seedSkill({ key: 'acme/toolbox/older', seenDaysAgo: 1 });
    const newer = await seedSkill({ key: 'acme/toolbox/newer', seenDaysAgo: 1 });
    const tied = await seedSkill({ key: 'acme/toolbox/tied', seenDaysAgo: 1 });

    await seedSearch([older], 5 * 24);
    await seedSearch([newer], 1);
    await seedSearch([tied], 5 * 24);

    const bands = await repository.selectRotationKeys(params({ cycleSlots: 3 }));

    // `newer` é o mais recente; `older` e `tied` empataram em 5 dias, e aí quem
    // decide é `source_key ASC` ("acme/toolbox/older" < "acme/toolbox/tied").
    expect(bands.hot.slice(0, 3)).toEqual([
      'acme/toolbox/newer',
      'acme/toolbox/older',
      'acme/toolbox/tied',
    ]);
  });

  it('rotates the cold set from the expired rows to the oldest', async () => {
    await seedSkill({ key: 'acme/toolbox/recent', seenDaysAgo: 8 });
    await seedSkill({ key: 'acme/toolbox/expired', seenDaysAgo: 20 });
    await seedSkill({ key: 'acme/toolbox/older', seenDaysAgo: 12 });
    await seedSkill({ key: 'acme/toolbox/expired-2', seenDaysAgo: 17 });

    const bands = await repository.selectRotationKeys(params({ hotSlots: 0, cycleSlots: 4 }));

    // Vencidas (mais de 14 dias) primeiro, e dentro do grupo/do resto, a mais
    // antiga primeiro.
    expect(bands.cold).toEqual([
      'acme/toolbox/expired',
      'acme/toolbox/expired-2',
      'acme/toolbox/older',
      'acme/toolbox/recent',
    ]);
    expect(bands.hot).toEqual([]);
  });

  it('cuts the cycle at cycleSlots and gives the hot set its hotSlots', async () => {
    const hotA = await seedSkill({ key: 'acme/toolbox/hot-a', seenDaysAgo: 2 });
    const hotB = await seedSkill({ key: 'acme/toolbox/hot-b', seenDaysAgo: 2 });
    const hotC = await seedSkill({ key: 'acme/toolbox/hot-c', seenDaysAgo: 2 });
    for (const [index, id] of [hotA, hotB, hotC].entries()) {
      await seedSearch([id], 1 + index);
    }
    for (const [index, key] of ['cold-a', 'cold-b', 'cold-c'].entries()) {
      await seedSkill({ key: `acme/toolbox/${key}`, seenDaysAgo: 9 + index });
    }

    const bands = await repository.selectRotationKeys(params({ hotSlots: 2, cycleSlots: 4 }));

    // Cada banda tem seu teto: hot em `hotSlots`, cold no que sobra do ciclo
    // (as mais antigas primeiro: cold-c tem 11 dias, cold-b tem 10).
    expect(bands.hot).toEqual(['acme/toolbox/hot-a', 'acme/toolbox/hot-b']);
    expect(bands.cold).toEqual(['acme/toolbox/cold-c', 'acme/toolbox/cold-b']);
    expect(new Set([...bands.hot, ...bands.cold]).size).toBe(4);
  });

  it('never repeats a key between hot and cold', async () => {
    const both = await seedSkill({ key: 'acme/toolbox/both', seenDaysAgo: 20 });
    await seedSearch([both], 1);
    await seedSkill({ key: 'acme/toolbox/cold', seenDaysAgo: 10 });

    const bands = await repository.selectRotationKeys(params({ hotSlots: 1, cycleSlots: 5 }));

    expect(bands.hot).toEqual(['acme/toolbox/both']);
    // A chave que está no hot pool inteiro não volta no cold (o `NOT EXISTS` é
    // sobre o pool, não só sobre as escolhidas).
    expect(bands.cold).not.toContain('acme/toolbox/both');
    expect(bands.cold).toContain('acme/toolbox/cold');
  });

  it('ignores inactive skills on both sides', async () => {
    const inactive = await seedSkill({
      key: 'acme/toolbox/inactive',
      seenDaysAgo: 20,
      isActive: false,
    });
    await seedSearch([inactive], 1);
    await seedSkill({ key: 'acme/toolbox/active', seenDaysAgo: 20 });

    const bands = await repository.selectRotationKeys(params());

    expect(bands).toEqual({ hot: [], cold: ['acme/toolbox/active'] });
  });

  it('answers empty bands for an empty catalog', async () => {
    expect(await repository.selectRotationKeys(params())).toEqual({ hot: [], cold: [] });
  });

  /**
   * F1 do parecer: a descoberta precisa do complemento **exato** do conjunto
   * ativo. Linha inativa conta como inédita — é reaparecendo na fonte que ela
   * volta a `is_active = true` —, e chave nunca vista também.
   */
  it('answers the enumerated keys that are not active rows', async () => {
    await seedSkill({ key: 'acme/toolbox/ativa', seenDaysAgo: 1 });
    await seedSkill({ key: 'acme/toolbox/inativa', seenDaysAgo: 40, isActive: false });

    const unseen = await repository.selectUnseenKeys([
      'acme/toolbox/nunca-vista',
      'acme/toolbox/ativa',
      'acme/toolbox/inativa',
      // Repetida e fora de ordem: a resposta preserva a ordem da fonte, sem repetir.
      'acme/toolbox/nunca-vista',
    ]);

    expect(unseen).toEqual(['acme/toolbox/nunca-vista', 'acme/toolbox/inativa']);
    expect(await repository.selectUnseenKeys([])).toEqual([]);
  });

  it('deactivates only what was not seen since the cutoff', async () => {
    await seedSkill({ key: 'acme/toolbox/fresh', seenDaysAgo: 1 });
    await seedSkill({ key: 'acme/toolbox/at-cutoff', seenDaysAgo: 28 });
    await seedSkill({ key: 'acme/toolbox/stale', seenDaysAgo: 29 });

    const deactivated = await repository.deactivateSkillsStaleBefore(daysAgo(28));

    expect(deactivated).toBe(1);
    const rows = await prisma.skill.findMany({
      select: { sourceKey: true, isActive: true },
      orderBy: { sourceKey: 'asc' },
    });
    expect(rows).toEqual([
      { sourceKey: 'acme/toolbox/at-cutoff', isActive: true },
      { sourceKey: 'acme/toolbox/fresh', isActive: true },
      { sourceKey: 'acme/toolbox/stale', isActive: false },
    ]);

    // Idempotente: a segunda passada não encontra nada ativo para desativar.
    expect(await repository.deactivateSkillsStaleBefore(daysAgo(28))).toBe(0);
  });

  it('records items_requested on the run', async () => {
    const withCycle = await repository.startRun({
      adapter: 'fixture',
      started_at: NOW,
      items_requested: 720,
    });
    // O lock de ingestão só admite um `running` por vez: fecha o primeiro antes.
    await repository.finishRun(withCycle, {
      status: 'ok',
      finished_at: NOW,
      items_seen: 720,
      items_upserted: 720,
      items_deactivated: 0,
    });
    const withoutCycle = await repository.startRun({
      adapter: 'fixture',
      started_at: new Date(NOW.getTime() + HOUR),
    });

    const rows = await prisma.ingestRun.findMany({
      select: { id: true, itemsRequested: true },
      orderBy: { id: 'asc' },
    });

    expect(rows).toEqual([
      { id: BigInt(withCycle), itemsRequested: 720 },
      // Sem ciclo, o dado ausente é `null` — nunca zero.
      { id: BigInt(withoutCycle), itemsRequested: null },
    ]);
  });

  it('has the migration applied: the items_requested column and the rotation index', async () => {
    const column = await prisma.$queryRaw<Array<{ data_type: string; is_nullable: string }>>`
      SELECT data_type, is_nullable
        FROM information_schema.columns
       WHERE table_name = 'ingest_run'
         AND column_name = 'items_requested'
    `;
    expect(column).toEqual([{ data_type: 'integer', is_nullable: 'YES' }]);

    const index = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
        FROM pg_indexes
       WHERE tablename = 'skill'
         AND indexname = 'skill_is_active_last_seen_at_idx'
    `;
    expect(index).toHaveLength(1);
    expect(index[0]?.indexdef).toContain('(is_active, last_seen_at)');
  });
});
