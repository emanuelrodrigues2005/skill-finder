/**
 * Duplo em memória da porta `SearchCatalog`.
 *
 * Existe para o mesmo motivo do `CatalogModule.forRoot({ repository })`: um dono
 * de teste (ou um ambiente de desenvolvimento sem Postgres) precisa da porta
 * cheia sem socket. O filtro textual é deliberadamente ingênuo — ele imita a
 * semântica (categoria, limite, paginação determinística), não a qualidade da
 * busca do Postgres.
 */
import type { CategoryItem, SkillDetail, SkillSummary } from '../contract/dto/catalog.dto';

import { decodeSkillId, encodeSkillId } from './ids';
import type {
  ListSkillsInput,
  SearchCatalog,
  SearchCatalogInput,
  SkillPage,
} from './search-catalog.port';

/** Conteúdo do duplo; tudo por injeção, nada lido do ambiente. */
export interface InMemoryCatalogSeed {
  readonly skills: readonly SkillSummary[];
  readonly categories?: readonly CategoryItem[];
  /** Instante do snapshot; `null` simula catálogo nunca ingerido. */
  readonly snapshotAt?: Date | null;
  /** Detalhes completos, por `skill_id` público. */
  readonly details?: ReadonlyMap<string, SkillDetail>;
}

export class InMemorySearchCatalog implements SearchCatalog {
  private readonly skills: readonly SkillSummary[];
  private readonly categories: readonly CategoryItem[];
  private readonly details: ReadonlyMap<string, SkillDetail>;
  private readonly snapshotAt: Date | null;

  constructor(seed: InMemoryCatalogSeed) {
    this.skills = seed.skills;
    this.snapshotAt = seed.snapshotAt ?? null;
    this.details =
      seed.details ??
      new Map(
        seed.skills.map((skill) => [
          skill.skill_id,
          // `data_snapshot` é do snapshot, não da linha: `SearchService.skillDetail`
          // preenche a partir de `snapshot()`, como no adaptador Postgres.
          { ...skill, summary: null, repo_url: null, skill_md_excerpt: null, data_snapshot: null },
        ]),
      );
    this.categories =
      seed.categories ??
      [...new Set(seed.skills.map((skill) => skill.category))]
        .filter((slug): slug is string => slug !== null)
        .map((slug) => ({ slug, label_en: slug, skill_count: 0 }));
  }

  search(input: SearchCatalogInput): Promise<readonly SkillSummary[]> {
    const terms = input.query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return Promise.resolve(
      this.skills
        .filter((skill) => input.category === null || skill.category === input.category)
        .filter((skill) => {
          const haystack = skill.name.toLowerCase();
          return terms.length === 0 || terms.some((term) => haystack.includes(term));
        })
        .slice(0, input.limit),
    );
  }

  findByIds(ids: readonly bigint[]): Promise<readonly SkillSummary[]> {
    return Promise.resolve(
      this.skills.filter((skill) => {
        const id = decodeSkillId(skill.skill_id);
        return id !== null && ids.includes(id);
      }),
    );
  }

  detail(skillId: bigint): Promise<SkillDetail | null> {
    const found = this.details.get(encodeSkillId(skillId));
    return Promise.resolve(found ?? null);
  }

  snapshot(): Promise<Date | null> {
    return Promise.resolve(this.snapshotAt);
  }

  categoryExists(slug: string): Promise<boolean> {
    return Promise.resolve(this.categories.some((category) => category.slug === slug));
  }

  listCategories(): Promise<readonly CategoryItem[]> {
    return Promise.resolve(this.categories);
  }

  listSkills(input: ListSkillsInput): Promise<SkillPage> {
    const filtered = this.skills.filter(
      (skill) => input.category === null || skill.category === input.category,
    );
    const sorted = [...filtered].sort((left, right) => compareBy(left, right, input.sortBy));
    const start = Math.max(0, (input.page - 1) * input.pageSize);
    return Promise.resolve({
      items: sorted.slice(start, start + input.pageSize),
      total_items: sorted.length,
    });
  }
}

/** Ordenação do duplo: ausente vai para o fim, empate pelo `skill_id`. */
function compareBy(left: SkillSummary, right: SkillSummary, sortBy: ListSkillsInput['sortBy']): number {
  if (sortBy === 'name') {
    return left.name.localeCompare(right.name) || left.skill_id.localeCompare(right.skill_id);
  }
  const leftValue = sortBy === 'stars' ? left.stars : left.installs;
  const rightValue = sortBy === 'stars' ? right.stars : right.installs;
  if (leftValue === rightValue) {
    return left.skill_id.localeCompare(right.skill_id);
  }
  if (leftValue === null) {
    return 1;
  }
  if (rightValue === null) {
    return -1;
  }
  return rightValue - leftValue;
}
