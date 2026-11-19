/**
 * Enriquecimento ao vivo (pedido do dono): matcher por `slug` e as guardas do serviço.
 *
 * O matcher é a parte que decide **quais** chaves do sitemap valem uma requisição, e
 * é pura — todo caso aqui roda sem rede. O serviço é testado só nas guardas que não
 * dependem de `ingest` (desligado, sem termo, sem chave casada): o caminho de
 * ingestão já tem suíte própria.
 */
import {
  CatalogLiveEnricher,
  matchKeysBySlug,
  slugTerms,
} from '@/catalog/live-enricher.service';
import type { AppConfigService } from '@/config/config.module';
import type { CatalogRepository } from '@/catalog/catalog-repository';
import type { SkillRecord, SkillSource } from '@/catalog/skill-source';

const CHAVES = [
  'anthropics/skills/webapp-testing',
  'vercel-labs/skills/find-skills',
  'obra/superpowers/tdd-workflow',
  'some-org/tools/pdf-table-extract',
];

describe('slugTerms', () => {
  it('extrai repo e slug, descartando termos curtos', () => {
    expect(slugTerms('anthropics/skills/webapp-testing')).toEqual([
      'skills',
      'webapp',
      'testing',
    ]);
  });

  it('normaliza maiúsculas e separadores', () => {
    expect(slugTerms('Owner/Repo/Some_Skill.name')).toEqual([
      'repo',
      'some',
      'skill',
      'name',
    ]);
  });
});

describe('matchKeysBySlug', () => {
  it('casa por prefixo nos dois sentidos (test -> testing, develop -> developer)', () => {
    expect(matchKeysBySlug(CHAVES, ['test'])).toEqual([
      'anthropics/skills/webapp-testing',
    ]);
    expect(matchKeysBySlug(CHAVES, ['testing'])).toEqual([
      'anthropics/skills/webapp-testing',
    ]);
  });

  it('um termo basta: "tdd" acha a chave certa', () => {
    expect(matchKeysBySlug(CHAVES, ['tdd'])).toEqual(['obra/superpowers/tdd-workflow']);
  });

  it('devolve lista vazia quando nenhum termo casa', () => {
    expect(matchKeysBySlug(CHAVES, ['kubernetes'])).toEqual([]);
  });

  it('ignora termos curtos demais (evita casar "de", "a", "of")', () => {
    expect(matchKeysBySlug(CHAVES, ['de', 'a', 'of'])).toEqual([]);
  });

  it('sem termos, nada casa — não devolve o catálogo inteiro', () => {
    expect(matchKeysBySlug(CHAVES, [])).toEqual([]);
  });

  it('preserva a ordem de entrada e não repete chave', () => {
    const casadas = matchKeysBySlug(CHAVES, ['skills', 'testing']);
    expect(casadas).toEqual([
      'anthropics/skills/webapp-testing',
      'vercel-labs/skills/find-skills',
    ]);
  });
});

/** Configuração mínima: o serviço só lê `liveEnrichEnabled` e `skillSourceKind`. */
function config(habilitado: boolean): AppConfigService {
  return {
    env: { liveEnrichEnabled: habilitado, skillSourceKind: 'html' },
  } as unknown as AppConfigService;
}

/** Fonte que só enumera; qualquer `fetchSkills` seria um bug do teste. */
function fonte(chaves: readonly string[]): SkillSource {
  return {
    capabilities: { supports_categories: false, supports_documents: false },
    listCategories: () => Promise.resolve([]),
    listKeys: () => Promise.resolve([...chaves]),
    fetchSkills: (): Promise<SkillRecord[]> => {
      throw new Error('fetchSkills nao deveria ser chamado');
    },
    fetchDocument: () => Promise.resolve(null),
  };
}

const REPOSITORIO = {} as CatalogRepository;

describe('CatalogLiveEnricher — guardas', () => {
  it('desligado na configuração: não toca a fonte', async () => {
    const enricher = new CatalogLiveEnricher(
      fonte(CHAVES),
      REPOSITORIO,
      config(false),
    );
    expect(enricher.enabled).toBe(false);
    await expect(enricher.enrich({ keywords: ['testing'] })).resolves.toBe(0);
  });

  it('sem palavra-chave: não enumera o sitemap', async () => {
    const enricher = new CatalogLiveEnricher(fonte(CHAVES), REPOSITORIO, config(true));
    await expect(enricher.enrich({ keywords: [] })).resolves.toBe(0);
  });

  it('nenhuma chave casando: devolve 0 sem chamar a fonte de detalhe', async () => {
    const enricher = new CatalogLiveEnricher(fonte(CHAVES), REPOSITORIO, config(true));
    await expect(enricher.enrich({ keywords: ['kubernetes'] })).resolves.toBe(0);
  });

  it('falha da fonte é engolida: a busca continua com o catálogo local', async () => {
    const quebrada: SkillSource = {
      ...fonte([]),
      listKeys: (): Promise<string[]> => Promise.reject(new Error('sitemap fora do ar')),
    };
    const enricher = new CatalogLiveEnricher(quebrada, REPOSITORIO, config(true));

    await expect(enricher.enrich({ keywords: ['testing'] })).resolves.toBe(0);
  });
});
