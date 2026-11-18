/**
 * Issue #7 — ingestão idempotente do catálogo: adaptador `fixture`.
 *
 * Contrato exigido do código de produção (`backend/src/catalog/fixture-source.ts`):
 *
 *   export function createFixtureSource(options?: { path?: string }): SkillSource;
 *   fetchCatalog(page), fetchDocument(key), fetchSkills(keys)   // #44: a chave é a unidade do rodízio
 *
 * O adaptador lê a amostra congelada da descoberta (`docs/app/amostras/skills-sample-2026-11-15.json`,
 * 25 skills reais de 2026-11-15), copiada byte a byte para `backend/test/fixtures/catalog-sample.json`
 * porque o espelho de verificação (`scripts/dev/verify.sh`) só copia `backend/` — o teste não lê
 * `docs/` em tempo de execução.
 *
 * Regras que este arquivo prova (`docs/app/amostras/README.md`, D3):
 * - a fixture já sai **normalizada**: `name` sem o sufixo `— owner/repo`, `source_key` de 3
 *   segmentos lowercase, `source_url` sempre `https://`, `vulnerability_count` sempre `null`
 *   (a fonte não publica o número) e `repo_url` sempre `null` (não sintetizar URL do repositório);
 * - a fonte não tem categorias nem `SKILL.md`: `listCategories()` devolve `[]` (resposta honesta)
 *   e `fetchDocument()` devolve `null`, com as capabilities dizendo isso de antemão.
 *
 * Âncoras numéricas: `25` itens (contagem da amostra), `4400000` instalações e `39400` estrelas da
 * primeira skill (`vercel-labs/skills/find-skills`), tirados da amostra — valores literais
 * independentes do código.
 */
import { createFixtureSource } from '@/catalog/fixture-source';
import type { SkillSource } from '@/catalog/skill-source';

const FIXTURE_ITEMS = 25;
const FIRST_KEY = 'vercel-labs/skills/find-skills';
const EM_DASH = '\u2014';
/** `owner/repo/slug`: 3 segmentos, minúsculos, sem domínio. */
const SOURCE_KEY = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

describe('catalog fixture source (docs/app/amostras/README.md)', () => {
  /** Fonte nova por teste: o adaptador não deve depender de estado compartilhado. */
  function source(): SkillSource {
    return createFixtureSource();
  }

  it('fetchCatalog(1) devolve os 25 itens da amostra numa página só', async () => {
    const page = await source().fetchCatalog(1);

    expect(page.page).toBe(1);
    expect(page.has_more).toBe(false);
    expect(page.items).toHaveLength(FIXTURE_ITEMS);
  });

  it('a segunda página é vazia e não promete mais nada', async () => {
    const page = await source().fetchCatalog(2);

    expect(page.items).toHaveLength(0);
    expect(page.has_more).toBe(false);
  });

  it('todas as chaves são únicas e no formato owner/repo/slug', async () => {
    const { items } = await source().fetchCatalog(1);

    for (const item of items) {
      expect(item.source_key).toMatch(SOURCE_KEY);
    }

    const keys = items.map((item) => item.source_key);
    expect(new Set(keys).size).toBe(FIXTURE_ITEMS);
  });

  it('todo vulnerability_count é null — a fonte não publica vulnerabilidades (D3)', async () => {
    const { items } = await source().fetchCatalog(1);

    for (const item of items) {
      expect(item.vulnerability_count).toBeNull();
    }
  });

  it('todo source_url começa com https://', async () => {
    const { items } = await source().fetchCatalog(1);

    expect(items).toHaveLength(FIXTURE_ITEMS);
    for (const item of items) {
      expect(typeof item.source_url).toBe('string');
      expect(item.source_url).toMatch(/^https:\/\//);
    }
  });

  it('nenhum name carrega o sufixo "— owner/repo"', async () => {
    const { items } = await source().fetchCatalog(1);

    for (const item of items) {
      expect(item.name).not.toContain(EM_DASH);
      expect(item.name).toBe(item.name.trim());
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it('todo repo_url é null — a fonte não dá a URL do repositório', async () => {
    const { items } = await source().fetchCatalog(1);

    for (const item of items) {
      expect(item.repo_url).toBeNull();
    }
  });

  it('a primeira skill da amostra sai com os números da amostra', async () => {
    const { items } = await source().fetchCatalog(1);
    const first = items.find((item) => item.source_key === FIRST_KEY);

    expect(first).toBeDefined();
    expect(first?.name).toBe('find-skills');
    expect(first?.installs).toBe(4400000);
    expect(first?.stars).toBe(39400);
    expect(first?.source_url).toBe('https://www.skills.sh/vercel-labs/skills/find-skills');
  });

  it('lista de categorias é vazia e as capabilities avisam', async () => {
    const adapter = source();

    expect(adapter.capabilities.supports_categories).toBe(false);
    expect(await adapter.listCategories()).toEqual([]);
  });

  it('não entrega SKILL.md: fetchDocument devolve null e as capabilities avisam', async () => {
    const adapter = source();

    expect(adapter.capabilities.supports_documents).toBe(false);
    expect(await adapter.fetchDocument(FIRST_KEY)).toBeNull();
  });

  /**
   * Issue #44 — `fetchSkills(keys)`: a chave é a unidade que o rodízio pede
   * (720 por ciclo), não a página. Não existe listagem paginada no skills.sh:
   * existem sitemap + página de detalhe, então quem sabe o `source_key` pede
   * por ele. Contrato: **só** chaves conhecidas, na ordem pedida, chave
   * desconhecida é ausência (nunca erro), repetida devolve um registro só.
   *
   * Chaves literais da amostra, tiradas da fixture — independentes do código.
   */
  describe('fetchSkills(keys) — a unidade do rodízio (#44)', () => {
    const SECOND_KEY = 'anthropics/skills/webapp-testing';
    const THIRD_KEY = 'clerk/skills/clerk-webhooks';

    it('devolve um registro por chave conhecida, na ordem pedida', async () => {
      const skills = await source().fetchSkills([SECOND_KEY, FIRST_KEY]);

      expect(skills.map((skill) => skill.source_key)).toEqual([SECOND_KEY, FIRST_KEY]);
      expect(skills[1]?.name).toBe('find-skills');
      expect(skills[1]?.installs).toBe(4400000);
    });

    it('omite as chaves desconhecidas e não lança', async () => {
      const skills = await source().fetchSkills([
        'nao-existe/skills/fantasma',
        FIRST_KEY,
        '../../etc/passwd',
        '',
      ]);

      expect(skills.map((skill) => skill.source_key)).toEqual([FIRST_KEY]);
    });

    it('só chaves desconhecidas: lista vazia, sem erro', async () => {
      await expect(source().fetchSkills(['nada/aqui/nao-existe'])).resolves.toEqual([]);
    });

    it('nenhuma chave pedida: lista vazia, sem tocar a fixture', async () => {
      await expect(source().fetchSkills([])).resolves.toEqual([]);
    });

    it('chave repetida devolve um registro só, na primeira posição pedida', async () => {
      const skills = await source().fetchSkills([FIRST_KEY, SECOND_KEY, FIRST_KEY]);

      expect(skills.map((skill) => skill.source_key)).toEqual([FIRST_KEY, SECOND_KEY]);
    });

    it('não devolve chave que não foi pedida', async () => {
      const skills = await source().fetchSkills([THIRD_KEY]);

      expect(skills).toHaveLength(1);
      expect(skills[0]?.source_key).toBe(THIRD_KEY);
    });
  });
});
