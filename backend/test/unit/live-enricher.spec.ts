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
  liveAdapterName,
  matchKeysBySlug,
  slugTerms,
} from '@/catalog/live-enricher.service';
import { ingest } from '@/catalog/ingest';
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

/**
 * Configuração mínima do serviço.
 *
 * Sem `budgetMs`/`rps` o `env` fica parcial de propósito: o serviço tem de cair
 * nos defaults (`DEFAULT_LIVE_ENRICH_BUDGET_MS`, 1 req/s), como em produção.
 */
function config(
  habilitado: boolean,
  extras: { budgetMs?: number; rps?: number } = {},
): AppConfigService {
  return {
    env: {
      liveEnrichEnabled: habilitado,
      skillSourceKind: 'html',
      ...(extras.budgetMs === undefined ? {} : { liveEnrichBudgetMs: extras.budgetMs }),
      ...(extras.rps === undefined ? {} : { skillSourceRps: extras.rps }),
    },
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

/** Espera real e curta: os casos de concorrência precisam de duas chamadas no ar. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Registro no formato interno do catálogo (`SkillRecord`), completo o suficiente. */
function registro(sourceKey: string): SkillRecord {
  return {
    source_key: sourceKey,
    source_url: `https://skills.sh/${sourceKey}`,
    name: sourceKey.split('/').pop() ?? sourceKey,
    summary: null,
    category_slug: null,
    stars: null,
    installs: null,
    vulnerability_count: null,
    security_status: 'unknown',
    repo_url: null,
    skill_md_present: false,
    first_seen_at: null,
    raw: null,
  };
}

/** Fonte que conta o que foi **pedido** — é assim que o single-flight é medido. */
interface FonteContada extends SkillSource {
  listagens: number;
  pedidos: number;
  chavesPedidas: string[][];
}

function fonteContada(chaves: readonly string[], atrasoMs = 0): FonteContada {
  const fonte: FonteContada = {
    capabilities: { supports_categories: false, supports_documents: false },
    listagens: 0,
    pedidos: 0,
    chavesPedidas: [],
    listCategories: () => Promise.resolve([]),
    listKeys: async (): Promise<string[]> => {
      fonte.listagens += 1;
      if (atrasoMs > 0) {
        await sleep(atrasoMs);
      }
      return [...chaves];
    },
    fetchSkills: (pedidas: readonly string[]): Promise<SkillRecord[]> => {
      fonte.pedidos += 1;
      fonte.chavesPedidas.push([...pedidas]);
      return Promise.resolve(pedidas.map(registro));
    },
    fetchDocument: () => Promise.resolve(null),
  };
  return fonte;
}

/**
 * Repositório de mentira com **só** o que o `ingest` com `keys` explícitas usa:
 * run, upsert e expurgo por idade. Nada de Postgres neste teste.
 */
function repositorioDeIngestao(): CatalogRepository {
  let runs = 0;
  return {
    failStaleRuns: () => Promise.resolve(0),
    startRun: () => {
      runs += 1;
      return Promise.resolve(`run-${String(runs)}`);
    },
    finishRun: () => Promise.resolve(),
    upsertSkills: (skills: readonly SkillRecord[]) => Promise.resolve(skills.length),
    deactivateSkillsStaleBefore: () => Promise.resolve(0),
  } as unknown as CatalogRepository;
}

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

/**
 * Fase 1 da auditoria de latência — single-flight.
 *
 * Duas buscas vazias simultâneas disparavam duas rodadas e disputavam o índice
 * parcial `UNIQUE (status) WHERE status='running'` de `ingest_run`: uma ganhava e
 * a outra registrava `warn`. Com o single-flight, a segunda chamada devolve `0`
 * sem abrir rodada — a fonte é lida uma vez.
 */
describe('CatalogLiveEnricher — single-flight', () => {
  it('duas rodadas simultâneas abrem uma só: a segunda devolve 0 sem tocar a fonte', async () => {
    const source = fonteContada(CHAVES, 20);
    const enricher = new CatalogLiveEnricher(source, repositorioDeIngestao(), config(true));

    const [primeira, segunda] = await Promise.all([
      enricher.enrich({ keywords: ['testing'] }),
      enricher.enrich({ keywords: ['testing'] }),
    ]);

    // Uma enumeração e um pedido de chaves: a rodada é uma só.
    expect(source.listagens).toBe(1);
    expect(source.pedidos).toBe(1);
    expect(primeira).toBe(1);
    // A chamada que chegou com a rodada no ar não espera nem duplica: devolve 0.
    expect(segunda).toBe(0);
  });

  it('encerrada a rodada, a próxima abre outra — o single-flight não é trava', async () => {
    const source = fonteContada(CHAVES);
    const enricher = new CatalogLiveEnricher(source, repositorioDeIngestao(), config(true));

    await enricher.enrich({ keywords: ['testing'] });
    await enricher.enrich({ keywords: ['testing'] });

    expect(source.listagens).toBe(2);
    expect(source.pedidos).toBe(2);
  });

  it('a rodada é liberada mesmo quando a fonte falha', async () => {
    let tentativas = 0;
    const quebrada: SkillSource = {
      ...fonteContada(CHAVES),
      listKeys: (): Promise<string[]> => {
        tentativas += 1;
        return tentativas === 1
          ? Promise.reject(new Error('sitemap fora do ar'))
          : Promise.resolve([...CHAVES]);
      },
    };
    const enricher = new CatalogLiveEnricher(quebrada, repositorioDeIngestao(), config(true));

    await expect(enricher.enrich({ keywords: ['testing'] })).resolves.toBe(0);
    // Sem liberar o `inFlight` no `finally`, o enriquecimento morreria após a
    // primeira falha da fonte e a busca nunca mais tentaria de novo.
    await expect(enricher.enrich({ keywords: ['testing'] })).resolves.toBe(1);
    expect(tentativas).toBe(2);
  });
});

/**
 * Fase 1 — orçamento da rodada (`LIVE_ENRICH_BUDGET_MS`, default 60 s).
 *
 * A rodada não pode ficar pendurada para sempre: sem `AbortSignal` (a fonte não
 * o aceita), o freio é **deixar de pedir chaves** quando o teto de tempo acaba.
 * Cada chave custa ~`1/SKILL_SOURCE_RPS` na fonte, então o orçamento que sobra
 * define quantas ainda cabem.
 */
describe('CatalogLiveEnricher — orçamento da rodada', () => {
  it('orçamento estourado antes das chaves: abandona e não pede nada à fonte', async () => {
    const source = fonteContada(CHAVES, 20);
    const enricher = new CatalogLiveEnricher(
      source,
      repositorioDeIngestao(),
      config(true, { budgetMs: 5, rps: 1 }),
    );

    await expect(enricher.enrich({ keywords: ['testing'] })).resolves.toBe(0);

    // A enumeração já consumiu os 5 ms: nenhuma chave é pedida.
    expect(source.listagens).toBe(1);
    expect(source.pedidos).toBe(0);
  });

  it('o orçamento limita quantas chaves a rodada pede, a 1 req/s', async () => {
    const source = fonteContada(CHAVES);
    const enricher = new CatalogLiveEnricher(
      source,
      repositorioDeIngestao(),
      // 2,5 s a 1 req/s = 2 chaves, mesmo com 4 casando e `limit` de 12.
      config(true, { budgetMs: 2_500, rps: 1 }),
    );

    const gravadas = await enricher.enrich({
      keywords: ['test', 'find', 'tdd', 'pdf'],
      limit: 12,
    });

    expect(source.chavesPedidas).toHaveLength(1);
    expect(source.chavesPedidas[0]).toHaveLength(2);
    expect(gravadas).toBe(2);
  });

  it('sem orçamento no env, vale o default de 60 s e nada é cortado', async () => {
    const source = fonteContada(CHAVES);
    const enricher = new CatalogLiveEnricher(source, repositorioDeIngestao(), config(true));

    await enricher.enrich({ keywords: ['test', 'find', 'tdd', 'pdf'], limit: 12 });

    expect(source.chavesPedidas[0]).toHaveLength(4);
  });
});

/**
 * Fase 5 da auditoria — a origem da rodada é legível em `ingest_run`.
 *
 * Toda busca vazia dispara `ingest({keys})` e grava uma linha com
 * `adapter='html'` e `items_requested=12`: em `GET /admin/ingest/runs` (e num
 * `SELECT adapter, count(*) FROM ingest_run GROUP BY 1`), ela era
 * **indistinguível** de um run do operador (`POST /admin/ingest`) ou do
 * agendador. A rodada automática passa a gravar o sufixo `+live` no `adapter`.
 *
 * O sufixo — e não uma coluna nova — porque `ingest_run.adapter` é `TEXT` sem
 * enum, não entra no contrato (`IngestRun` não o expõe) e ninguém ramifica em
 * cima do valor gravado: quem escolhe o adaptador é `CATALOG_ADAPTER`, não a
 * coluna. Um sufixo não muda nenhum dos dois.
 */
describe('CatalogLiveEnricher — origem da rodada', () => {
  /** Repositório que registra o `adapter` de cada `startRun` — é a coluna do banco. */
  function repositorioQueRegistra(): {
    readonly repo: CatalogRepository;
    readonly adapters: string[];
  } {
    const adapters: string[] = [];
    const repo = {
      failStaleRuns: () => Promise.resolve(0),
      startRun: (run: { adapter: string }): Promise<number> => {
        adapters.push(run.adapter);
        return Promise.resolve(1);
      },
      finishRun: () => Promise.resolve(),
      upsertSkills: (skills: readonly SkillRecord[]) => Promise.resolve(skills.length),
      deactivateSkillsStaleBefore: () => Promise.resolve(0),
    } as unknown as CatalogRepository;
    return { repo, adapters };
  }

  it('a rodada disparada pela busca grava html+live, não html', async () => {
    const { repo, adapters } = repositorioQueRegistra();
    const enricher = new CatalogLiveEnricher(fonteContada(CHAVES), repo, config(true));

    await enricher.enrich({ keywords: ['testing'] });

    expect(adapters).toEqual(['html+live']);
  });

  it('a rodada do operador continua gravando só o adaptador da fonte', async () => {
    const { repo, adapters } = repositorioQueRegistra();

    // O caminho do `POST /admin/ingest` e do agendador: `ingest` chamado direto,
    // sem o sufixo do enriquecimento ao vivo.
    await ingest({
      source: fonteContada(CHAVES),
      repository: repo,
      adapter: 'html',
      startedAt: new Date('2026-11-19T12:00:00.000Z'),
      keys: ['anthropics/skills/webapp-testing'],
    });

    expect(adapters).toEqual(['html']);
  });

  it('o sufixo preserva o adaptador como prefixo, para o agrupamento por LIKE', () => {
    // `adapter LIKE 'html%'` continua achando as duas origens; `html+live` não
    // inventa um adaptador que não existe no `SKILL_SOURCE_KIND`.
    expect(liveAdapterName('html')).toBe('html+live');
    expect(liveAdapterName('fixture')).toBe('fixture+live');
  });
});
