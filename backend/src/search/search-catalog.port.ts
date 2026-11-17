/**
 * Porta de leitura do catálogo para a busca (`docs/app/02-arquitetura.md` §7).
 *
 * É o único caminho pelo qual o serviço de busca conhece skills: a implementação
 * de produção fala Postgres (`prisma-search-catalog.repository.ts`) e os testes
 * injetam um duplo em memória — nenhum teste abre socket.
 *
 * Duas línguas convivem aqui de propósito: `SkillSummary.skill_id` já sai no
 * formato público (`sk_...`, decisão D-B) porque ele vai direto para a resposta,
 * enquanto `findByIds`/`detail` falam a língua do banco (`bigint`), como a
 * coluna `skill.id`. A conversão mora em `ids.ts`, não no chamador.
 */
import type { CategoryItem, SkillDetail, SkillSummary } from '../contract/dto/catalog.dto';

import type { SkillSortField } from './constants';

/** Argumentos da recuperação de candidatos (`POST /api/v1/search`). */
export interface SearchCatalogInput {
  /** Texto já validado do usuário; a consulta é livre, o resultado é ranqueado. */
  readonly query: string;
  /** Slug existente ou `null` para todas as categorias. */
  readonly category: string | null;
  /** Quantos candidatos trazer: o ranking corta depois. */
  readonly limit: number;
}

/** Argumentos de `GET /api/v1/skills` (§5.4, §5.6). */
export interface ListSkillsInput {
  readonly category: string | null;
  readonly sortBy: SkillSortField;
  readonly page: number;
  readonly pageSize: number;
}

/** Página de skills; `total_items` é do filtro, não da página. */
export interface SkillPage {
  readonly items: readonly SkillSummary[];
  readonly total_items: number;
}

export interface SearchCatalog {
  /** Candidatos ativos do snapshot; `skill_id` já no formato público. */
  search(input: SearchCatalogInput): Promise<readonly SkillSummary[]>;

  /** Linhas por id do banco, para o replay de um permalink (ordem não importa). */
  findByIds(ids: readonly bigint[]): Promise<readonly SkillSummary[]>;

  /** Detalhe de `GET /api/v1/skills/{skill_id}`; `null` quando o id não existe. */
  detail(skillId: bigint): Promise<SkillDetail | null>;

  /** Instante do snapshot do catálogo; `null` quando o catálogo nunca foi ingerido. */
  snapshot(): Promise<Date | null>;

  /** `true` quando o slug existe em `category` (D-A). */
  categoryExists(slug: string): Promise<boolean>;

  /** Categorias do snapshot, para o seletor da interface. */
  listCategories(): Promise<readonly CategoryItem[]>;

  /** Listagem paginada e ordenada do catálogo. */
  listSkills(input: ListSkillsInput): Promise<SkillPage>;
}
