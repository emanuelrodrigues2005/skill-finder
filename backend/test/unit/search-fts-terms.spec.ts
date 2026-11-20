/**
 * Fase 2 da auditoria da busca — o `tsquery` da `search_doc`.
 *
 * O `search_doc` é indexado com `to_tsvector('english', ...)`
 * (`prisma-catalog.repository.ts`) e `websearch_to_tsquery` lê **espaço como
 * AND**: `preciso skill agente revise pull requests python procurando` vira
 * "todas essas palavras no documento", o que nenhuma linha cumpre — 0 resultados
 * garantido. `or` é operador aceito pela mesma função e devolve o que a busca
 * promete: as skills que casam com *algum* termo.
 *
 * O teto de quatro termos existe porque OR sem teto vira varredura: cada termo a
 * mais é um ramo novo do `tsquery`, e o último caso deste arquivo mostra o preço
 * honesto da correção — uma consulta em que nenhum termo existe no documento
 * continua devolvendo zero.
 */
import type { SkillSummary } from '@/contract/dto/catalog.dto';
import { lexicalKeywords } from '@/llm/intent-schema';
import { encodeSkillId } from '@/search/ids';
import { InMemorySearchCatalog } from '@/search/in-memory-search-catalog';
import { ftsTerms } from '@/search/search-catalog.port';

describe('ftsTerms — semântica do tsquery', () => {
  it('joins the keywords with `or` instead of a space (space is AND)', () => {
    expect(ftsTerms({ query: 'qualquer coisa', keywords: ['a', 'b', 'c'] })).toBe('a or b or c');
  });

  it('caps the terms at four, so OR does not become a scan', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'];

    const terms = ftsTerms({ query: '', keywords: six });

    expect(terms).toBe('a or b or c or d');
    expect(terms.split(' or ')).toHaveLength(4);
  });

  it('keeps `or` out of the edges: an empty keyword list with an empty query is ""', () => {
    const terms = ftsTerms({ query: '', keywords: [] });

    expect(terms).toBe('');
    expect(terms).not.toContain(' or ');
  });

  it('ignores blank keywords instead of spending a term slot on them', () => {
    expect(ftsTerms({ query: 'ignorada', keywords: ['  ', 'python', ''] })).toBe('python');
  });

  it('falls back to the raw query when the intent brought no term', () => {
    // Degradação sem termo em inglês: o `tsquery` recebe a consulta como veio
    // (é o `ILIKE` que salva a busca), nunca uma string de operadores solta.
    expect(ftsTerms({ query: 'quero uma skill de frontend', keywords: [] })).toBe(
      'quero uma skill de frontend',
    );
  });
});

describe('busca em português com a LLM fora, contra um catálogo inglês (Fase 2)', () => {
  /** Nomes no formato do catálogo real: o `search_doc` é inglês. */
  function skill(id: bigint, name: string): SkillSummary {
    return {
      skill_id: encodeSkillId(id),
      name,
      source_url: null,
      category: null,
      stars: null,
      installs: null,
      vulnerability_count: null,
      security_status: 'unknown',
      skill_md_present: false,
    };
  }

  const catalog = new InMemorySearchCatalog({
    skills: [
      skill(1n, 'imagegen-frontend-web'),
      skill(2n, 'webapp-testing'),
      skill(3n, 'pr-hygiene'),
    ],
  });

  it('returns at least one skill when at least one term matches', async () => {
    const query = 'quero uma skill de frontend';

    // Caminho degradado de verdade: `LLM_ENABLED=false` -> `lexicalKeywords`.
    const keywords = lexicalKeywords(query);
    const found = await catalog.search({ query, keywords, category: null, limit: 10 });

    expect(found.length).toBeGreaterThan(0);
    expect(found.map((item) => item.name)).toContain('imagegen-frontend-web');
    // E o termo que casa está no `tsquery`, unido por `or`.
    expect(ftsTerms({ query, keywords })).toContain('frontend');
    expect(ftsTerms({ query, keywords })).toContain(' or ');
  });

  it('still returns zero when no term exists in the english document', async () => {
    // Limite honesto da correção, fixado como teste: OR não inventa casamento.
    const query = 'preciso de um agente que revise governança de dados';
    const keywords = lexicalKeywords(query);
    const found = await catalog.search({ query, keywords, category: null, limit: 10 });

    expect(keywords.length).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});
