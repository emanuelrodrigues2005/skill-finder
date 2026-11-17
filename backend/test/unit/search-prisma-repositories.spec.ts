/**
 * Issue #12 — os ramos dos dois adaptadores Prisma da busca
 * (`prisma-search-catalog.repository.ts` 40% e
 * `prisma-search-store.repository.ts` 44,4% de branches).
 *
 * A integração cobre o caminho com Postgres de verdade; o que sobra são os
 * caminhos de **resposta vazia** e de **linha incompleta**, que decidem entre
 * `null` e um valor inventado — exatamente a regra 3 do `AGENTS.md`:
 *
 * - `findByIds([])` não consulta o banco (um `IN ()` vazio é erro de SQL);
 * - `detail` sem linha é `null` (o serviço traduz em 404);
 * - `snapshot` sem linha é `null` (o serviço traduz em 503, nunca em "catálogo de
 *   hoje");
 * - `listSkills` sem total é `0`, não `undefined` na paginação;
 * - `toStoredRow` **lança** quando a linha não tem `intent` — uma busca gravada
 *   por fora da API não pode virar permalink com intenção vazia;
 * - colunas opcionais nulas (`candidates_count`, `llm_status`, `latency_ms`)
 *   caem nos defaults documentados.
 *
 * O `PrismaClient` é um duplo: registra o SQL e devolve as linhas que cada caso
 * precisa. Nenhum socket.
 */
import type { PrismaClient } from '@prisma/client';

import type { SkillDetail } from '@/contract/dto/catalog.dto';
import type { Intent } from '@/contract/dto/search-response.dto';
import { PrismaSearchCatalogRepository } from '@/search/prisma-search-catalog.repository';
import { PrismaSearchStoreRepository } from '@/search/prisma-search-store.repository';
import { encodeSkillId } from '@/search/ids';
import type { StoredSearchFields } from '@/search/search-store.port';

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

/** Linha como o `SELECT` de `prisma-search-catalog.repository.ts` a devolve. */
interface SkillRowFixture {
  id: bigint;
  name: string;
  source_url: string | null;
  category_slug: string | null;
  stars: number | null;
  installs: number | null;
  vulnerability_count: number | null;
  security_status: string;
  skill_md_present: boolean;
}

function row(overrides: Partial<SkillRowFixture> = {}): SkillRowFixture {
  return {
    id: 1n,
    name: 'find-skills',
    source_url: 'https://skills.sh/acme/toolbox/find-skills',
    category_slug: 'discovery',
    stars: 128,
    installs: 42,
    vulnerability_count: null,
    security_status: 'unknown',
    skill_md_present: false,
    ...overrides,
  };
}

class FakePrisma {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  queryRows: unknown[] = [];
  createRow: unknown = null;
  findUniqueRow: unknown = null;
  readonly createArgs: unknown[] = [];
  readonly findUniqueArgs: unknown[] = [];

  readonly $queryRaw = (first: unknown, ...rest: unknown[]): Promise<unknown[]> => {
    this.calls.push(record(first, rest));
    return Promise.resolve(this.queryRows);
  };

  /** A porta do histórico usa o delegate tipado, não SQL bruto (§4.1). */
  readonly searchRequest = {
    create: (args: unknown): Promise<unknown> => {
      this.createArgs.push(args);
      return Promise.resolve(this.createRow);
    },
    findUnique: (args: unknown): Promise<unknown> => {
      this.findUniqueArgs.push(args);
      return Promise.resolve(this.findUniqueRow);
    },
  };
}

/**
 * Registra uma chamada de `$queryRaw` no formato que o Prisma entrega ao driver:
 * os fragmentos `Prisma.Sql` aninhados (`SELECT ${colunas}`, `${Prisma.join(ids)}`,
 * `ORDER BY ${order}`) são **achatados** em texto + parâmetros. Sem esse
 * achatamento o duplo veria objetos onde o Postgres vê valores, e a asserção
 * sobre o parâmetro passaria a medir outra coisa.
 */
function record(
  first: unknown,
  rest: readonly unknown[],
): { sql: string; values: readonly unknown[] } {
  if (!Array.isArray(first)) {
    if (isSqlLike(first)) {
      return { sql: first.sql, values: first.values };
    }
    return { sql: String(first), values: rest };
  }

  const parts = first as string[];
  let sql = '';
  const values: unknown[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    sql += parts[index] ?? '';
    if (index >= rest.length) {
      continue;
    }
    const value = rest[index];
    if (isSqlLike(value)) {
      sql += value.sql;
      values.push(...value.values);
    } else {
      sql += '?';
      values.push(value);
    }
  }
  return { sql: sql.replace(/\s+/g, ' ').trim(), values };
}

function catalog(): { prisma: FakePrisma; repo: PrismaSearchCatalogRepository } {
  const prisma = new FakePrisma();
  return { prisma, repo: new PrismaSearchCatalogRepository(prisma as unknown as PrismaClient) };
}

describe('PrismaSearchCatalogRepository — recuperação', () => {
  it('maps a database row to the contract summary, with the public id (D-B)', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [row({ id: 7n })];

    const found = await repo.search({ query: 'find skills', category: null, limit: 5 });
    const [item] = found;

    expect(found).toHaveLength(1);
    expect(item?.skill_id).toBe(encodeSkillId(7n));
    expect(item?.stars).toBe(128);
    // Regra 3: ausente continua `null` na borda.
    expect(item?.vulnerability_count).toBeNull();
    expect(prisma.calls).toHaveLength(1);
    expect(prisma.calls[0]?.sql).toContain('search_doc @@');
    expect(prisma.calls[0]?.values).toContain('find skills');
  });

  it('does not query the database for an empty id set', async () => {
    const { prisma, repo } = catalog();

    // `IN ()` é erro de sintaxe no Postgres: a porta responde sem consultar.
    expect(await repo.findByIds([])).toEqual([]);
    expect(prisma.calls).toEqual([]);
  });

  it('returns the rows of the given ids, in whatever order the database chose', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [row({ id: 9n, name: 'beta' })];

    const found = await repo.findByIds([9n]);

    expect(found.map((item) => item.name)).toEqual(['beta']);
    expect(prisma.calls[0]?.values).toEqual([9n]);
  });
});

describe('PrismaSearchCatalogRepository — detalhe', () => {
  it('answers null when the id does not exist', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [];

    expect(await repo.detail(404n)).toBeNull();
  });

  it('keeps the three optional fields null when the row has none of them', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [{ ...row(), summary: null, repo_url: null, document: null }];

    const detail = (await repo.detail(1n)) as SkillDetail;

    expect(detail.summary).toBeNull();
    expect(detail.repo_url).toBeNull();
    expect(detail.skill_md_excerpt).toBeNull();
  });

  it('converts the stored markdown to plain text within the contract ceilings', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [
      {
        ...row(),
        summary: '# Resumo\n\nUsa `pnpm` e **testes**.',
        repo_url: 'https://github.com/acme/toolbox',
        document: '# Find skills\n\n```bash\npnpm add x\n```\nAjuda a achar skills.',
      },
    ];

    const detail = (await repo.detail(1n)) as SkillDetail;

    expect(detail.repo_url).toBe('https://github.com/acme/toolbox');
    expect(detail.summary).toBe('Resumo\nUsa pnpm e testes.');
    expect(detail.summary).not.toContain('#');
    expect(detail.skill_md_excerpt).toContain('Find skills');
    expect(detail.skill_md_excerpt).toContain('Ajuda a achar skills.');
    expect(detail.skill_md_excerpt).not.toContain('pnpm add x');
    expect(detail.skill_md_excerpt).not.toContain('```');
    expect(detail.skill_md_excerpt?.length).toBeLessThanOrEqual(600);
  });
});

describe('PrismaSearchCatalogRepository — snapshot, categorias e listagem', () => {
  it('answers null for a catalog that was never ingested', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [];

    expect(await repo.snapshot()).toBeNull();
  });

  it('answers the last `last_seen_at` of the active rows', async () => {
    const { prisma, repo } = catalog();
    const snapshot = new Date('2026-11-17T12:00:00.000Z');
    prisma.queryRows = [{ snapshot }];

    expect(await repo.snapshot()).toEqual(snapshot);
  });

  it('tells an existing category from a missing one', async () => {
    const { prisma, repo } = catalog();

    prisma.queryRows = [];
    expect(await repo.categoryExists('nao-existe')).toBe(false);

    prisma.queryRows = [{ slug: 'backend' }];
    expect(await repo.categoryExists('backend')).toBe(true);
  });

  it('maps the category list with the count of active skills', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [
      { slug: 'backend', label_en: 'Backend', skill_count: 2 },
      { slug: 'testing', label_en: 'Testing', skill_count: 0 },
    ];

    expect(await repo.listCategories()).toEqual([
      { slug: 'backend', label_en: 'Backend', skill_count: 2 },
      { slug: 'testing', label_en: 'Testing', skill_count: 0 },
    ]);
  });

  it('paginates with the total of the filter and zero when the total query is empty', async () => {
    const { prisma, repo } = catalog();
    prisma.queryRows = [row({ id: 3n, name: 'gamma' })];

    const page = await repo.listSkills({
      category: 'backend',
      sortBy: 'stars',
      page: 2,
      pageSize: 1,
    });

    expect(page.items.map((item) => item.name)).toEqual(['gamma']);
    expect(page.total_items).toBe(0);
    // O `ORDER BY` vem do mapa fechado, nunca do texto do cliente.
    expect(prisma.calls[0]?.sql).toContain('s.stars DESC NULLS LAST, s.id ASC');
    // `OFFSET` da página 2 com 1 por página.
    expect(prisma.calls[0]?.values).toContain(1);
  });
});

describe('PrismaSearchStoreRepository', () => {
  const INTENT: Intent = {
    category: 'backend',
    keywords: ['python'],
    filters: { exclude_with_vulnerabilities: false },
    language: 'en',
    confidence: 0.8,
  };

  function record(overrides: Partial<StoredSearchFields> = {}): StoredSearchFields {
    return {
      request_id: 'req_01JCV8Y6Q4NAOEXISTE0000000',
      created_at: new Date('2026-11-17T12:00:00.000Z'),
      client_hash: 'a'.repeat(64),
      query_hash: 'b'.repeat(64),
      query_text: null,
      intent: INTENT,
      category_slug: 'backend',
      result_ids: [7n, 9n],
      candidates_count: 2,
      llm_status: 'ok',
      degraded: false,
      latency_ms: 12,
      status: 'ok',
      ...overrides,
    };
  }

  /** Linha como o `select` do repositório a devolve (nomes camelCase do Prisma). */
  function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11',
      requestId: 'req_01JCV8Y6Q4NAOEXISTE0000000',
      createdAt: new Date('2026-11-17T12:00:00.000Z'),
      clientHash: 'a'.repeat(64),
      queryHash: 'b'.repeat(64),
      queryText: null,
      intent: INTENT,
      categorySlug: 'backend',
      resultIds: [7n, 9n],
      candidatesCount: 2,
      llmStatus: 'ok',
      degraded: false,
      latencyMs: 12,
      status: 'ok',
      ...overrides,
    };
  }

  function store(): { prisma: FakePrisma; repo: PrismaSearchStoreRepository } {
    const prisma = new FakePrisma();
    return { prisma, repo: new PrismaSearchStoreRepository(prisma as unknown as PrismaClient) };
  }

  it('saves the record and returns the row with the database search_id', async () => {
    const { prisma, repo } = store();
    prisma.createRow = storedRow();

    const saved = await repo.save({ ...record(), toJSON: () => ({}) });

    expect(saved.search_id).toBe('b0d1f3a2-7c1e-4a55-9f0e-2d4a1c6b8e11');
    expect(saved.request_id).toBe(record().request_id);
    expect(saved.result_ids).toEqual([7n, 9n]);
    // O `data` enviado ao Prisma usa os nomes das colunas mapeadas.
    const [args] = prisma.createArgs as Array<{ data: Record<string, unknown> }>;
    expect(args?.data.requestId).toBe(record().request_id);
    expect(args?.data.resultIds).toEqual([7n, 9n]);
  });

  it('answers null for a request_id that is not in the history', async () => {
    const { prisma, repo } = store();
    prisma.findUniqueRow = null;

    expect(await repo.findByRequestId('req_01JCV8Y6Q4DESCONHECIDO00')).toBeNull();
    const [args] = prisma.findUniqueArgs as Array<{ where: { requestId: string } }>;
    expect(args?.where.requestId).toBe('req_01JCV8Y6Q4DESCONHECIDO00');
  });

  it('throws when a stored row has no intent', async () => {
    const { prisma, repo } = store();
    prisma.findUniqueRow = storedRow({ intent: null });

    // Falhar alto é melhor do que devolver um permalink com intenção vazia.
    await expect(repo.findByRequestId(record().request_id)).rejects.toThrow(
      /has no stored intent/,
    );
  });

  it('falls back to the documented defaults for null columns', async () => {
    const { prisma, repo } = store();
    prisma.findUniqueRow = storedRow({
      candidatesCount: null,
      llmStatus: null,
      latencyMs: null,
      queryText: null,
      categorySlug: null,
    });

    const found = await repo.findByRequestId(record().request_id);

    expect(found?.candidates_count).toBe(0);
    expect(found?.llm_status).toBe('unavailable');
    expect(found?.latency_ms).toBe(0);
    expect(found?.query_text).toBeNull();
    expect(found?.category_slug).toBeNull();
    // A linha devolvida carrega a própria projeção JSON (`BIGINT[]` > string).
    expect(found?.toJSON()).toMatchObject({ result_ids: ['7', '9'] });
  });
});
