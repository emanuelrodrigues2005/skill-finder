/**
 * Implementação Prisma/Postgres da porta de leitura do catálogo (§4.1, §7).
 *
 * Toda consulta é SQL bruto (`$queryRaw`): a busca textual usa `search_doc`
 * (`tsvector`, `Unsupported` no Prisma Schema) e o `ts_rank`, que não existem
 * como campo tipado. As três garantias do doc:
 *
 * - **nada de `OFFSET` sem ordem total**: toda listagem termina em `s.id ASC`,
 *   senão duas páginas seguidas podem repetir a mesma skill;
 * - **`NULLS LAST`**: `stars`/`installs` ausentes vão para o fim da ordenação, e
 *   continuam `null` no payload — dado ausente nunca vira zero (regra 3);
 * - `skill_id` sai no formato público (D-B) já aqui: o chamador não conhece
 *   `bigint`.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

import type { CategoryItem, SkillDetail, SkillSummary } from '../contract/dto/catalog.dto';

import { encodeSkillId } from './ids';
import type {
  ListSkillsInput,
  SearchCatalog,
  SearchCatalogInput,
  SkillPage,
} from './search-catalog.port';
import { plainSummary, skillMdExcerpt } from './skill-md';

/** Colunas de `skill` que viram `SkillSummary`; o `id` fica `bigint` até a borda. */
const SUMMARY_COLUMNS = Prisma.sql`
  s.id, s.name, s.source_url, s.category_slug, s.stars, s.installs,
  s.vulnerability_count, s.security_status, s.skill_md_present
`;

/**
 * `ORDER BY` por `sort_by` (§5.6).
 *
 * `Prisma.raw` e não interpolação: o fragmento é escolhido por chave de um mapa
 * fechado, nunca montado com o texto do cliente — é o que impede um `sort_by`
 * arbitrário de chegar ao SQL.
 */
const ORDER_BY: Record<ListSkillsInput['sortBy'], Prisma.Sql> = {
  installs: Prisma.raw('s.installs DESC NULLS LAST, s.id ASC'),
  stars: Prisma.raw('s.stars DESC NULLS LAST, s.id ASC'),
  name: Prisma.raw('s.name ASC, s.id ASC'),
};

interface SkillRow {
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

interface SkillDetailRow extends SkillRow {
  summary: string | null;
  repo_url: string | null;
  document: string | null;
}

export class PrismaSearchCatalogRepository implements SearchCatalog {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Candidatos por casamento textual (`search_doc`, GIN) com `ts_rank`; o nome da
   * skill entra como segunda chance porque a consulta do usuário costuma citar a
   * skill pelo nome.
   */
  async search(input: SearchCatalogInput): Promise<readonly SkillSummary[]> {
    const query = Prisma.sql`websearch_to_tsquery('english', ${input.query})`;
    const rows = await this.prisma.$queryRaw<SkillRow[]>`
      SELECT ${SUMMARY_COLUMNS}
        FROM "skill" AS s
       WHERE s.is_active = true
         AND (${input.category}::text IS NULL OR s.category_slug = ${input.category})
         AND (
               s.search_doc @@ ${query}
               OR s.name ILIKE '%' || ${input.query} || '%'
             )
       ORDER BY ts_rank(s.search_doc, ${query}) DESC,
                s.installs DESC NULLS LAST,
                s.stars DESC NULLS LAST,
                s.id ASC
       LIMIT ${input.limit}
    `;
    return rows.map(toSummary);
  }

  /**
   * Linhas por id do banco, na ordem que o banco quiser: quem manda na ordem do
   * permalink é `result_ids` (o ranking da busca original), não esta consulta.
   */
  async findByIds(ids: readonly bigint[]): Promise<readonly SkillSummary[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.prisma.$queryRaw<SkillRow[]>`
      SELECT ${SUMMARY_COLUMNS}
        FROM "skill" AS s
       WHERE s.id IN (${Prisma.join(ids)})
         AND s.is_active = true
    `;
    return rows.map(toSummary);
  }

  /** Detalhe + trecho de `SKILL.md`; `null` quando o id não existe. */
  async detail(skillId: bigint): Promise<SkillDetail | null> {
    const rows = await this.prisma.$queryRaw<SkillDetailRow[]>`
      SELECT ${SUMMARY_COLUMNS}, s.summary, s.repo_url, d.content AS document
        FROM "skill" AS s
        LEFT JOIN "skill_document" AS d ON d.skill_id = s.id
       WHERE s.id = ${skillId}
       LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      ...toSummary(row),
      summary: row.summary === null ? null : plainSummary(row.summary),
      repo_url: row.repo_url,
      skill_md_excerpt: row.document === null ? null : skillMdExcerpt(row.document),
    };
  }

  /** `max(last_seen_at)` do que está ativo: a data da última ingestão (§7.3). */
  async snapshot(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ snapshot: Date | null }>>`
      SELECT max(s.last_seen_at) AS snapshot
        FROM "skill" AS s
       WHERE s.is_active = true
    `;
    return rows[0]?.snapshot ?? null;
  }

  async categoryExists(slug: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ slug: string }>>`
      SELECT slug FROM "category" WHERE slug = ${slug} LIMIT 1
    `;
    return rows.length > 0;
  }

  /** Categorias na ordem do catálogo (`position`), com a contagem de skills ativas. */
  async listCategories(): Promise<readonly CategoryItem[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ slug: string; label_en: string; skill_count: number }>
    >`
      SELECT c.slug,
             c.label_en,
             count(s.id)::int AS skill_count
        FROM "category" AS c
        LEFT JOIN "skill" AS s
               ON s.category_slug = c.slug
              AND s.is_active = true
       GROUP BY c.slug, c.label_en, c.position
       ORDER BY c.position ASC, c.slug ASC
    `;
    return rows.map((row) => ({
      slug: row.slug,
      label_en: row.label_en,
      skill_count: row.skill_count,
    }));
  }

  /** Página ordenada do catálogo; `total_items` é do filtro, não da página. */
  async listSkills(input: ListSkillsInput): Promise<SkillPage> {
    const order = ORDER_BY[input.sortBy];
    const offset = Math.max(0, (input.page - 1) * input.pageSize);

    const rows = await this.prisma.$queryRaw<SkillRow[]>`
      SELECT ${SUMMARY_COLUMNS}
        FROM "skill" AS s
       WHERE s.is_active = true
         AND (${input.category}::text IS NULL OR s.category_slug = ${input.category})
       ORDER BY ${order}
       LIMIT ${input.pageSize} OFFSET ${offset}
    `;
    const totals = await this.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
        FROM "skill" AS s
       WHERE s.is_active = true
         AND (${input.category}::text IS NULL OR s.category_slug = ${input.category})
    `;

    return {
      items: rows.map(toSummary),
      total_items: totals[0]?.total ?? 0,
    };
  }
}

/** Linha do banco -> `SkillSummary` do contrato (id público, ausente é `null`). */
function toSummary(row: SkillRow): SkillSummary {
  return {
    skill_id: encodeSkillId(row.id),
    name: row.name,
    source_url: row.source_url,
    category: row.category_slug,
    stars: row.stars,
    installs: row.installs,
    vulnerability_count: row.vulnerability_count,
    // `CHECK (security_status IN (...))` de §4.1: o banco só guarda os quatro.
    security_status: row.security_status as SkillSummary['security_status'],
    skill_md_present: row.skill_md_present,
  };
}
