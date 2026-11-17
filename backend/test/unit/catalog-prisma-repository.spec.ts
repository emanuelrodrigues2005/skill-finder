/**
 * Issue #12 — os ramos de `prisma-catalog.repository.ts` que o banco não exercita
 * (58,3% de branches antes deste spec).
 *
 * `catalog-sql.spec.ts` prova a **forma** das duas statements; a integração prova
 * a semântica com Postgres de verdade. O que sobrava sem teste são os caminhos de
 * erro e as escolhas de valor que nenhum run feliz percorre:
 *
 * - `startRun` sem linha de volta (o `INSERT ... RETURNING id` quebrado) tem de
 *   **lançar**, não devolver `NaN` como id de run;
 * - `countActiveSkills` sem linha é `0` — nunca `undefined` chegando na guarda de
 *   80% (que compara inteiros);
 * - `upsertSkills` com lote vazio é `0` e **nenhuma statement**;
 * - `first_seen_at` ausente na fonte cai em `seenAt` (a coluna é `NOT NULL`);
 * - `finishRun` grava `error_code`/`error_detail` nulos e preenchidos.
 *
 * O `PrismaClient` é um duplo que registra o SQL recebido: nenhum socket, e a
 * asserção é sobre o que **saiu** do repositório.
 */
import type { PrismaClient } from '@prisma/client';

import type { IngestRunFinish } from '@/catalog/catalog-repository';
import {
  PrismaCatalogRepository,
  buildUpsertStatement,
} from '@/catalog/prisma-catalog.repository';
import type { SkillRecord } from '@/catalog/skill-source';

const SEEN_AT = new Date('2026-11-17T12:00:00.000Z');

interface RecordedCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface SqlLike {
  readonly sql: string;
  readonly values: unknown[];
}

function isSqlLike(value: unknown): value is SqlLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sql?: unknown }).sql === 'string' &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

/**
 * Duplo do `PrismaClient`: aceita as duas formas que o repositório usa —
 * template marcado (`$executeRaw\`...\``) e `Prisma.Sql` já montado.
 */
class FakePrisma {
  readonly calls: RecordedCall[] = [];
  queryRows: unknown[] = [];
  private executions = 0;

  readonly $queryRaw = (first: unknown, ...rest: unknown[]): Promise<unknown[]> => {
    this.calls.push(record(first, rest));
    return Promise.resolve(this.queryRows);
  };

  readonly $executeRaw = (first: unknown, ...rest: unknown[]): Promise<number> => {
    this.calls.push(record(first, rest));
    this.executions += 1;
    return Promise.resolve(this.executions);
  };

  readonly $transaction = (operations: readonly Promise<unknown>[]): Promise<unknown[]> =>
    Promise.all(operations);
}

function record(first: unknown, rest: readonly unknown[]): RecordedCall {
  if (Array.isArray(first)) {
    // Tagged template: `first` são os pedaços literais, `rest` os parâmetros.
    return { sql: (first as string[]).join('?'), values: rest };
  }
  if (isSqlLike(first)) {
    return { sql: first.sql, values: first.values };
  }
  return { sql: String(first), values: rest };
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    source_key: 'acme/toolbox/find-skills',
    source_url: 'https://skills.sh/acme/toolbox/find-skills',
    name: 'find-skills',
    summary: 'Finds skills',
    category_slug: null,
    stars: 128,
    installs: 42,
    vulnerability_count: null,
    security_status: 'unknown',
    repo_url: null,
    skill_md_present: false,
    first_seen_at: new Date('2026-11-01T00:00:00.000Z'),
    raw: { rank: 1 },
    ...overrides,
  };
}

function repository(): { prisma: FakePrisma; repo: PrismaCatalogRepository } {
  const prisma = new FakePrisma();
  return { prisma, repo: new PrismaCatalogRepository(prisma as unknown as PrismaClient) };
}

describe('PrismaCatalogRepository — runs', () => {
  it('returns the id of the run the database created', async () => {
    const { prisma, repo } = repository();
    prisma.queryRows = [{ id: 42n }];

    expect(await repo.startRun({ adapter: 'fixture', started_at: SEEN_AT })).toBe(42);

    const [call] = prisma.calls;
    expect(call?.sql).toContain('INSERT INTO "ingest_run"');
    expect(call?.values).toEqual(['fixture', SEEN_AT]);
  });

  it('throws instead of returning NaN when the insert comes back empty', async () => {
    const { prisma, repo } = repository();
    prisma.queryRows = [];

    await expect(repo.startRun({ adapter: 'fixture', started_at: SEEN_AT })).rejects.toThrow(
      'INSERT em ingest_run não devolveu id',
    );
  });

  it('closes stale runs with STALE_RUN before the cutoff', async () => {
    const { prisma, repo } = repository();

    expect(await repo.failStaleRuns(SEEN_AT)).toBe(1);

    const [call] = prisma.calls;
    expect(call?.sql).toContain(`SET status = 'failed'::"IngestStatus"`);
    expect(call?.sql).toContain('error_code');
    expect(call?.sql).toContain(`WHERE status = 'running'::"IngestStatus"`);
    expect(call?.values).toEqual(['STALE_RUN', SEEN_AT]);
  });

  it('writes the finishing patch, with and without an error', async () => {
    const { prisma, repo } = repository();

    const ok: IngestRunFinish = {
      status: 'ok',
      finished_at: SEEN_AT,
      items_seen: 25,
      items_upserted: 25,
      items_deactivated: 0,
      error_code: null,
      error_detail: null,
    };
    await repo.finishRun(7, ok);

    const failed: IngestRunFinish = {
      ...ok,
      status: 'failed',
      error_code: 'REPOSITORY_FAILED',
      error_detail: 'boom',
    };
    await repo.finishRun(8, failed);

    const [first, second] = prisma.calls;
    expect(first?.sql).toContain('UPDATE "ingest_run"');
    expect(first?.values).toContain(7n);
    expect(first?.values).toContain(null); // `error_code ?? null`
    expect(second?.values).toContain('REPOSITORY_FAILED');
    expect(second?.values).toContain('boom');
  });
});

describe('PrismaCatalogRepository — contagem e desativação', () => {
  it('counts the active skills', async () => {
    const { prisma, repo } = repository();
    prisma.queryRows = [{ active: 7n }];

    expect(await repo.countActiveSkills()).toBe(7);
    expect(prisma.calls[0]?.sql).toContain('is_active = true');
  });

  it('answers zero when the count query returns no row', async () => {
    const { prisma, repo } = repository();
    prisma.queryRows = [];

    // `undefined` na guarda de 80% viraria `NaN` na comparação: o piso é `0`.
    expect(await repo.countActiveSkills()).toBe(0);
  });

  it('deactivates what was not seen since the cutoff', async () => {
    const { prisma, repo } = repository();

    await repo.deactivateSkillsNotSeenSince(SEEN_AT);

    const [call] = prisma.calls;
    expect(call?.sql).toContain('SET is_active = false');
    expect(call?.sql).toContain('last_seen_at <');
    expect(call?.values).toEqual([SEEN_AT]);
  });
});

describe('PrismaCatalogRepository — upsertSkills', () => {
  it('does nothing, and writes nothing, for an empty batch', async () => {
    const { prisma, repo } = repository();

    expect(await repo.upsertSkills([], SEEN_AT)).toBe(0);
    expect(prisma.calls).toEqual([]);
  });

  it('writes the upsert and the metric snapshot of the batch in one transaction', async () => {
    const { prisma, repo } = repository();

    const written = await repo.upsertSkills(
      [skill({ source_key: 'acme/toolbox/a' }), skill({ source_key: 'acme/toolbox/b' })],
      SEEN_AT,
    );

    expect(written).toBe(2);
    expect(prisma.calls).toHaveLength(2);
    expect(prisma.calls[0]?.sql).toContain('ON CONFLICT (source_key) DO UPDATE');
    expect(prisma.calls[1]?.sql).toContain('INSERT INTO "skill_metric_snapshot"');
    expect(prisma.calls[1]?.values).toContain('acme/toolbox/a');
  });

  it('counts distinct keys, not items, and returns that number', async () => {
    const { prisma, repo } = repository();

    const written = await repo.upsertSkills(
      [
        skill({ source_key: 'acme/toolbox/dup' }),
        skill({ source_key: 'acme/toolbox/dup', stars: 999 }),
      ],
      SEEN_AT,
    );

    expect(written).toBe(1);
    // Uma linha só: o `21000` do Postgres não pode ser alcançável.
    expect(prisma.calls[0]?.values.filter((value) => value === 'acme/toolbox/dup')).toHaveLength(1);
  });

  it('splits a batch above 500 rows into more than one statement pair', async () => {
    const { prisma, repo } = repository();
    const many = Array.from({ length: 501 }, (_unused, index) =>
      skill({ source_key: `acme/toolbox/skill-${String(index)}` }),
    );

    const written = await repo.upsertSkills(many, SEEN_AT);

    expect(written).toBe(501);
    // Dois lotes: upsert + snapshot em cada um.
    expect(prisma.calls).toHaveLength(4);
  });

  it('falls back to `seenAt` when the source has no first sighting, and keeps raw null', async () => {
    const { prisma, repo } = repository();

    await repo.upsertSkills([skill({ first_seen_at: null, raw: null })], SEEN_AT);

    const statement = buildUpsertStatement([skill({ first_seen_at: null, raw: null })], SEEN_AT);
    const captured = prisma.calls[0];

    expect(captured?.sql).toBe(statement.sql);
    // `first_seen_at` (12º parâmetro da linha) cai no `seenAt` do run...
    expect(captured?.values[11]).toEqual(SEEN_AT);
    // ...e `raw` ausente vai como JSON `null`, não como `undefined`.
    expect(captured?.values[13]).toBe('null');
  });
});
