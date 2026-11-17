/**
 * Issue #7 — ingestão idempotente do catálogo: adaptador `fixture`.
 *
 * Contrato exigido do código de produção (`backend/src/catalog/fixture-source.ts`):
 *
 *   export function createFixtureSource(options?: { path?: string }): SkillSource;
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
});
