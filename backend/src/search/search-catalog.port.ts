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
  /**
   * Texto já validado do usuário, **cru**. Serve só ao `name ILIKE`: o nome da
   * skill pode estar no idioma da consulta, e é isso que faz uma busca em
   * português citar a skill pelo nome.
   */
  readonly query: string;
  /**
   * Termos em inglês que o passo de intenção extraiu (issue #40).
   *
   * O `search_doc` é indexado com `to_tsvector('english', ...)`, então é por aqui
   * — e não pela consulta crua — que a busca textual casa. Lista vazia é
   * permitida: o adaptador cai na `query` e a busca nunca deixa de responder.
   */
  readonly keywords: readonly string[];
  /** Slug existente ou `null` para todas as categorias. */
  readonly category: string | null;
  /** Quantos candidatos trazer: o ranking corta depois. */
  readonly limit: number;
}

/**
 * Teto de termos do `tsquery` (Fase 2 da auditoria da busca).
 *
 * OR sem teto é varredura: cada termo é um ramo novo que o GIN precisa visitar e
 * o `ts_rank` precisa somar. Quatro é o que cabe de uma consulta curta sem
 * transformar o operador em "case com qualquer palavra".
 */
export const MAX_FTS_TERMS = 4;

/** Operador do `websearch_to_tsquery` que separa os termos (aceita `or`). */
const FTS_OR = ' or ';

/**
 * Texto que vai ao `tsquery` do `search_doc`: os termos em inglês da intenção,
 * unidos por `or` (issue #40, corrigido na Fase 2 da auditoria).
 *
 * `websearch_to_tsquery` lê **espaço como AND** — unir os termos por espaço pedia
 * que um único documento contivesse todos eles, o que devolve zero para qualquer
 * consulta vinda do fallback lexical em português. `or` é o operador que a mesma
 * função entende, e devolve o que a busca promete: a skill que casa com algum
 * termo. O teto de {@link MAX_FTS_TERMS} segura a varredura.
 *
 * Vive na porta, e não em cada adaptador, porque é a mesma regra para todos: sem
 * termo em inglês (intenção degradada, provedor `disabled`) volta à consulta crua
 * — a busca responde pior, mas nunca deixa de responder. O adaptador em memória
 * imita exatamente esta semântica.
 */
export function ftsTerms(input: Pick<SearchCatalogInput, 'query' | 'keywords'>): string {
  const terms = input.keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0)
    .slice(0, MAX_FTS_TERMS);
  return terms.length > 0 ? terms.join(FTS_OR) : input.query;
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
