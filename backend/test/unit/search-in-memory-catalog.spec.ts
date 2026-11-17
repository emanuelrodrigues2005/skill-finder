/**
 * Issue #12 — o duplo em memória da porta `SearchCatalog`
 * (`backend/src/search/in-memory-search-catalog.ts`).
 *
 * O duplo tinha **0% de cobertura** e é justamente o que a suíte `api` injeta no
 * lugar do adaptador Postgres: um defeito aqui não aparece como teste vermelho,
 * aparece como teste que passa medindo a coisa errada. Os casos fixam a
 * semântica que o duplo promete imitar (categoria, limite, paginação
 * determinística, ausente no fim da ordem), não detalhes internos.
 *
 * Duas línguas convivem na porta: `skill_id` sai no formato público (`sk_...`) e
 * `findByIds`/`detail` falam `bigint`, como a coluna do banco.
 */
import type { CategoryItem, SkillDetail, SkillSummary } from '@/contract/dto/catalog.dto';
import { encodeSkillId } from '@/search/ids';
import {
  InMemorySearchCatalog,
  type InMemoryCatalogSeed,
} from '@/search/in-memory-search-catalog';

/** Skill de teste: `id` é o `bigint` do banco, o resto tem default explícito. */
function skill(id: bigint, overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    skill_id: encodeSkillId(id),
    name: `skill-${String(id)}`,
    source_url: null,
    category: 'backend',
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: 'unknown',
    skill_md_present: false,
    ...overrides,
  };
}

function catalog(seed: Partial<InMemoryCatalogSeed> & { skills: readonly SkillSummary[] }) {
  return new InMemorySearchCatalog(seed);
}

/** Busca com o mínimo preenchido: o resto é `null`/limite alto. */
function searchInput(overrides: Partial<Parameters<InMemorySearchCatalog['search']>[0]> = {}) {
  return { query: '', category: null, limit: 100, ...overrides };
}

describe('InMemorySearchCatalog — search (match lexical)', () => {
  const skills = [
    skill(1n, { name: 'python-security-review' }),
    skill(2n, { name: 'pr-hygiene' }),
    skill(3n, { name: 'terraform-plan', category: 'infra' }),
  ];

  it('matches any term of the query against the name, case-insensitively', async () => {
    const found = await catalog({ skills }).search(searchInput({ query: 'PYTHON' }));

    expect(found.map((item) => item.name)).toEqual(['python-security-review']);
  });

  it('is a union over the terms, not an intersection', async () => {
    // "destaque + listagem": quem digita duas palavras quer as skills de cada uma,
    // não só as que tenham as duas no nome.
    const found = await catalog({ skills }).search(searchInput({ query: 'python terraform' }));

    expect(found.map((item) => item.name)).toEqual(['python-security-review', 'terraform-plan']);
  });

  it('an empty or whitespace query returns everything up to the limit', async () => {
    const instance = catalog({ skills });

    expect(await instance.search(searchInput({ query: '' }))).toHaveLength(3);
    expect(await instance.search(searchInput({ query: '   ' }))).toHaveLength(3);
  });

  it('filters by category and ignores the filter when category is null', async () => {
    const instance = catalog({ skills });

    const infra = await instance.search(searchInput({ category: 'infra' }));
    expect(infra.map((item) => item.name)).toEqual(['terraform-plan']);

    expect(await instance.search(searchInput({ category: 'backend' }))).toHaveLength(2);
    expect(await instance.search(searchInput({ category: null }))).toHaveLength(3);
  });

  it('truncates at `limit` and keeps the seeded order', async () => {
    const found = await catalog({ skills }).search(searchInput({ limit: 2 }));

    expect(found.map((item) => item.name)).toEqual(['python-security-review', 'pr-hygiene']);
  });

  it('answers an empty list when nothing matches', async () => {
    expect(await catalog({ skills }).search(searchInput({ query: 'kubernetes' }))).toEqual([]);
  });
});

describe('InMemorySearchCatalog — findByIds e detail', () => {
  const skills = [
    skill(7n, { name: 'alpha' }),
    skill(9n, { name: 'beta' }),
    // `skill_id` que não decodifica: o duplo não pode estourar por causa dele.
    skill(11n, { name: 'malformado', skill_id: 'sk_invalido' }),
  ];

  it('returns only the rows whose database id was asked for', async () => {
    const found = await catalog({ skills }).findByIds([7n, 11n]);

    // `sk_invalido` não decodifica (`null`), então entra em nenhum conjunto.
    expect(found.map((item) => item.name)).toEqual(['alpha']);
  });

  it('returns an empty list for an empty id set', async () => {
    expect(await catalog({ skills }).findByIds([])).toEqual([]);
  });

  it('serves a full detail when the seed provides one', async () => {
    const detail: SkillDetail = {
      ...skill(7n, { name: 'alpha', stars: 10 }),
      summary: 'resumo',
      repo_url: 'https://github.com/acme/alpha',
      skill_md_excerpt: 'trecho',
    };
    const instance = catalog({ skills, details: new Map([[encodeSkillId(7n), detail]]) });

    expect(await instance.detail(7n)).toEqual(detail);
    // Sem os três campos opcionais declarados, o detalhe não é o mesmo objeto.
    expect(await instance.detail(9n)).toBeNull();
  });

  it('derives a detail with the optional fields null when none was seeded', async () => {
    const found = await catalog({ skills }).detail(9n);

    expect(found).toEqual({
      ...skill(9n, { name: 'beta' }),
      summary: null,
      repo_url: null,
      skill_md_excerpt: null,
    });
  });

  it('answers null for an id that is not in the catalog', async () => {
    expect(await catalog({ skills }).detail(99n)).toBeNull();
  });
});

describe('InMemorySearchCatalog — snapshot e categorias', () => {
  it('answers null when the catalog was never ingested (default)', async () => {
    expect(await catalog({ skills: [skill(1n)] }).snapshot()).toBeNull();
  });

  it('answers the seeded snapshot instant', async () => {
    const snapshotAt = new Date('2026-11-17T12:00:00.000Z');

    expect(await catalog({ skills: [skill(1n)], snapshotAt }).snapshot()).toEqual(snapshotAt);
  });

  it('derives the category list from the skills when none was seeded', async () => {
    const instance = catalog({
      skills: [
        skill(1n, { name: 'a', category: 'backend' }),
        skill(2n, { name: 'b', category: null }),
        skill(3n, { name: 'c', category: 'testing' }),
        skill(4n, { name: 'd', category: 'backend' }),
      ],
    });

    // `null` não é categoria; chave repetida aparece uma vez, na ordem do seed.
    expect(await instance.listCategories()).toEqual([
      { slug: 'backend', label_en: 'backend', skill_count: 0 },
      { slug: 'testing', label_en: 'testing', skill_count: 0 },
    ]);
    expect(await instance.categoryExists('backend')).toBe(true);
    expect(await instance.categoryExists('infra')).toBe(false);
  });

  it('uses the seeded category list as-is', async () => {
    const categories: readonly CategoryItem[] = [
      { slug: 'dev', label_en: 'Developer tools', skill_count: 4 },
    ];
    const instance = catalog({ skills: [], categories });

    expect(await instance.listCategories()).toEqual(categories);
    expect(await instance.categoryExists('dev')).toBe(true);
    expect(await instance.categoryExists('backend')).toBe(false);
  });
});

describe('InMemorySearchCatalog — listSkills (ordem determinística)', () => {
  const skills = [
    skill(20n, { name: 'beta', stars: 10, installs: 5 }),
    skill(21n, { name: 'alpha', stars: 10, installs: 7 }),
    skill(22n, { name: 'gamma', stars: null, installs: null }),
    skill(23n, { name: 'delta', stars: 5, installs: 5 }),
  ];

  function listInput(overrides: Partial<Parameters<InMemorySearchCatalog['listSkills']>[0]> = {}) {
    return { category: null, sortBy: 'installs' as const, page: 1, pageSize: 10, ...overrides };
  }

  it('orders by name with `skill_id` as tie-breaker', async () => {
    const page = await catalog({ skills }).listSkills(listInput({ sortBy: 'name' }));

    expect(page.items.map((item) => item.name)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(page.total_items).toBe(4);
  });

  it('orders by stars descending, absent last, `skill_id` as tie-breaker', async () => {
    const page = await catalog({ skills }).listSkills(listInput({ sortBy: 'stars' }));

    // 20 e 21 empatam em 10 -> `skill_id` menor primeiro (20 = beta); `null`
    // (gamma) vai para o fim, nunca para o começo.
    expect(page.items.map((item) => item.name)).toEqual(['beta', 'alpha', 'delta', 'gamma']);
    expect(page.items.at(-1)?.stars).toBeNull();
  });

  it('orders by installs descending, absent last', async () => {
    const page = await catalog({ skills }).listSkills(listInput({ sortBy: 'installs' }));

    // 21 tem 7 instalações; 20 e 23 empatam em 5 -> id menor (20) primeiro.
    expect(page.items.map((item) => item.name)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(page.items.map((item) => item.installs)).toEqual([7, 5, 5, null]);
  });

  it('filters by category before paginating and counts the filter', async () => {
    const scoped = [
      skill(1n, { name: 'a', category: 'backend' }),
      skill(2n, { name: 'b', category: 'infra' }),
      skill(3n, { name: 'c', category: 'backend' }),
    ];

    const page = await catalog({ skills: scoped }).listSkills(listInput({ category: 'backend' }));

    expect(page.items.map((item) => item.name)).toEqual(['a', 'c']);
    expect(page.total_items).toBe(2);
  });

  it('paginates deterministically and stops at the last page', async () => {
    const instance = catalog({ skills });

    const second = await instance.listSkills(listInput({ sortBy: 'name', page: 2, pageSize: 2 }));
    expect(second.items.map((item) => item.name)).toEqual(['delta', 'gamma']);
    expect(second.total_items).toBe(4);

    const beyond = await instance.listSkills(listInput({ sortBy: 'name', page: 5, pageSize: 2 }));
    expect(beyond.items).toEqual([]);
    expect(beyond.total_items).toBe(4);
  });

  it('clamps a page below 1 to the first page instead of a negative offset', async () => {
    const page = await catalog({ skills }).listSkills(
      listInput({ sortBy: 'name', page: 0, pageSize: 2 }),
    );

    expect(page.items.map((item) => item.name)).toEqual(['alpha', 'beta']);
  });
});
