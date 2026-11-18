/**
 * Issue #47 — o único adaptador real do catálogo: HTML + sitemap, 1 req/s.
 *
 * Contrato exigido de `backend/src/catalog/html-source.ts`:
 *
 *   export interface HtmlSourceClock { now(): number; sleep(ms: number): Promise<void>; }
 *   export interface HtmlSourceOptions { baseUrl?; rps?; timeoutMs?; clock?: HtmlSourceClock }
 *   export function createHtmlSource(options?: HtmlSourceOptions): SkillSource;
 *
 * O que este spec prova (parecer de segurança da #47):
 *
 * - `fetchSkills(keys)` busca a página de detalhe de cada chave **enumerada pelo
 *   sitemap** e parseia com `parseDetailHtml` (`backend/src/catalog/html-parser.ts`);
 * - 1 req/s vem de `SKILL_SOURCE_RPS` com **relógio injetado**: o teste não dorme,
 *   só registra o intervalo pedido ao relógio falso;
 * - caminho proibido pelo `robots.txt` (`/search`, `/api/`, `/internal/`,
 *   `/debug-security/`) nunca é buscado, nem quando a chave pedida tem essa forma;
 * - 200 com HTML **não** é existência: página sem identidade (nome + ao menos uma
 *   métrica) é `miss`, nunca um registro com métrica `null`;
 * - página que falha (HTTP, rede ou conteúdo) não derruba o run e nunca devolve
 *   registro vazio que apagaria métrica já ingerida — a chave simplesmente falta;
 * - chave fora do sitemap não é buscada (a base é fixa + `source_key` do sitemap).
 *
 * Fixtures reais em `backend/test/fixtures/`: `skill-detail.html` é a página
 * SSR de `vercel-labs/skills/find-skills` copiada de
 * `docs/app/amostras/skill-detalhe.html` (coleta de 2026-11-15), e `sitemap*.xml`
 * são extratos literais dos arquivos da mesma coleta. `skill-missing.html`
 * reproduz o shell da SPA que responde 200 para caminho inexistente (sem os
 * rótulos `Installs`/`GitHub Stars`); nenhuma página 404 real foi capturada.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Test } from '@nestjs/testing';
import nock from 'nock';

import { CATALOG_ADAPTER, CATALOG_SOURCE, CatalogModule } from '@/catalog/catalog.module';
import type { CatalogRepository } from '@/catalog/catalog-repository';
import {
  createHtmlSource,
  type HtmlSourceClock,
  type HtmlSourceOptions,
} from '@/catalog/html-source';
import type { SkillSource } from '@/catalog/skill-source';

const BASE = 'https://www.skills.sh';
const FIRST = 'vercel-labs/skills/find-skills';
const SECOND = 'inference-sh/skills/ai-video-generation';
const THIRD = 'inference-sh/skills/ai-image-generation';
const FOURTH = 'inference-sh/skills/ai-avatar-video';
const UNKNOWN = 'nao-existe/skills/fantasma';
const FORBIDDEN = 'search/qualquer/coisa';

const FIXTURES = join(process.cwd(), 'test', 'fixtures');
const DETAIL_HTML = readFileSync(join(FIXTURES, 'skill-detail.html'), 'utf8');
const MISS_HTML = readFileSync(join(FIXTURES, 'skill-missing.html'), 'utf8');
const SITEMAP_INDEX = readFileSync(join(FIXTURES, 'sitemap.xml'), 'utf8');
const SITEMAP_SHARD = readFileSync(join(FIXTURES, 'sitemap-skills-1.xml'), 'utf8');

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };

/** Relógio falso: registrar o `sleep` pedido em vez de dormir de verdade. */
interface FakeClock {
  readonly clock: HtmlSourceClock;
  readonly sleeps: number[];
  advance(ms: number): void;
  now(): number;
}

function fakeClock(start = 1_000): FakeClock {
  let current = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      now: () => current,
      sleep: (ms: number): Promise<void> => {
        sleeps.push(ms);
        current += ms;
        return Promise.resolve();
      },
    },
    advance: (ms: number) => {
      current += ms;
    },
    now: () => current,
  };
}

/** Interceptor do índice de sitemaps (uma vez por teste). */
function sitemapIndex(): nock.Scope {
  return nock(BASE).get('/sitemap.xml').reply(200, SITEMAP_INDEX, {
    'content-type': 'application/xml',
  });
}

/** Interceptor do shard `sitemap-skills-1.xml` (uma vez por teste). */
function sitemapShard(): nock.Scope {
  return nock(BASE).get('/sitemap-skills-1.xml').reply(200, SITEMAP_SHARD, {
    'content-type': 'application/xml',
  });
}

/** Interceptor da página de detalhe de uma chave do sitemap. */
function detailPage(key: string, status = 200, body = DETAIL_HTML): nock.Scope {
  return nock(BASE).get(`/${key}`).reply(status, body, HTML_HEADERS);
}

function source(overrides: Partial<HtmlSourceOptions> = {}): SkillSource {
  return createHtmlSource({
    baseUrl: BASE,
    rps: 1,
    clock: fakeClock().clock,
    ...overrides,
  });
}

/** Repositório de teste: o módulo só precisa de um; nenhum método é chamado. */
function stubRepository(): CatalogRepository {
  const fail = (): Promise<never> => Promise.reject(new Error('nao deveria ser chamado'));
  return {
    failStaleRuns: fail,
    startRun: fail,
    finishRun: fail,
    countActiveSkills: fail,
    selectRotationKeys: fail,
    upsertSkills: fail,
    deactivateSkillsNotSeenSince: fail,
    deactivateSkillsStaleBefore: fail,
  };
}

afterEach(() => {
  nock.cleanAll();
});

describe('fetchSkills — detail', () => {
  it('busca cada página de detalhe do sitemap e parseia as métricas', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    detailPage(SECOND);

    const records = await source().fetchSkills([FIRST, SECOND]);

    expect(records.map((record) => record.source_key)).toEqual([FIRST, SECOND]);
    expect(records[0]).toMatchObject({
      name: 'find-skills',
      installs: 4_400_000,
      stars: 39_400,
      source_url: `${BASE}/${FIRST}`,
      vulnerability_count: null,
      repo_url: null,
      skill_md_present: false,
    });
    // O texto cru (`Jan 26, 2026`) vira `Date` em `normaliseSkill`; comparar pelo
    // instante evita depender do `TZ` da máquina que roda a suíte.
    expect(records[0]?.first_seen_at?.getTime()).toBe(Date.parse('Jan 26, 2026'));
    // O título do site é `find-skills — vercel-labs/skills`; o resumo vem do meta.
    expect(records[0]?.summary).toMatch(/^Helps users discover and install agent skills/);
    expect(nock.isDone()).toBe(true);
  });

  it('devolve os registros na ordem pedida, não na ordem do sitemap', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(SECOND);
    detailPage(FIRST);

    const records = await source().fetchSkills([SECOND, FIRST]);

    expect(records.map((record) => record.source_key)).toEqual([SECOND, FIRST]);
  });

  it('chave desconhecida é ausência: não é buscada e não lança', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const trap = detailPage(UNKNOWN);

    const records = await source().fetchSkills([UNKNOWN, FIRST, '../../etc/passwd', '']);

    expect(records.map((record) => record.source_key)).toEqual([FIRST]);
    expect(trap.isDone()).toBe(false);
  });

  it('chave repetida devolve um registro só, na primeira posição pedida', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);

    const records = await source().fetchSkills([FIRST, FIRST]);

    expect(records.map((record) => record.source_key)).toEqual([FIRST]);
  });

  it('nenhuma chave pedida: lista vazia e nenhuma requisição', async () => {
    const trap = sitemapIndex();

    await expect(source().fetchSkills([])).resolves.toEqual([]);
    expect(trap.isDone()).toBe(false);
  });

  it('não busca SKILL.md nesta issue — nem declara suporte a documento', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const trap = nock(BASE).get(`/${FIRST}/SKILL.md`).reply(200, '# find-skills');

    const adapter = source();
    await adapter.fetchSkills([FIRST]);

    expect(adapter.capabilities).toEqual({
      supports_categories: false,
      supports_documents: false,
    });
    expect(await adapter.fetchDocument(FIRST)).toBeNull();
    expect(await adapter.listCategories()).toEqual([]);
    expect(trap.isDone()).toBe(false);
  });

  it('fetchCatalog é o método depreciado: recusa e aponta o caminho novo', async () => {
    await expect(source().fetchCatalog(1)).rejects.toThrow(/fetchSkills/);
  });
});

describe('rate limit — rps', () => {
  it('espaça as requisições em 1000 ms com SKILL_SOURCE_RPS=1, no relógio injetado', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    detailPage(SECOND);
    const fake = fakeClock(0);

    await createHtmlSource({ baseUrl: BASE, rps: 1, clock: fake.clock }).fetchSkills([
      FIRST,
      SECOND,
    ]);

    // Requisições: sitemap.xml, sitemap-skills-1.xml, detalhe, detalhe.
    // A primeira passa direto; as três seguintes esperam o intervalo de 1 s.
    expect(fake.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(fake.now()).toBe(3_000);
  });

  it('usa 1000/SKILL_SOURCE_RPS como intervalo', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const fake = fakeClock();

    await createHtmlSource({ baseUrl: BASE, rps: 2, clock: fake.clock }).fetchSkills([FIRST]);

    // sitemap (sem espera), shard (+500 ms), detalhe (+500 ms).
    expect(fake.sleeps).toEqual([500, 500]);
  });

  it('não dorme quando a chamada seguinte chega depois do intervalo', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    detailPage(SECOND);
    const fake = fakeClock();
    const adapter = createHtmlSource({ baseUrl: BASE, rps: 1, clock: fake.clock });

    await adapter.fetchSkills([FIRST]);
    expect(fake.sleeps).toEqual([1_000, 1_000]);

    // O relógio andou 5 s: o sitemap está em cache e a página sai sem espera.
    fake.advance(5_000);
    await adapter.fetchSkills([SECOND]);

    expect(fake.sleeps).toEqual([1_000, 1_000]);
  });

  it('recusa SKILL_SOURCE_RPS não positivo em vez de virar espera infinita', () => {
    expect(() => createHtmlSource({ baseUrl: BASE, rps: 0 })).toThrow(/rps/i);
    expect(() => createHtmlSource({ baseUrl: BASE, rps: Number.NaN })).toThrow(/rps/i);
  });
});

describe('robots — caminho proibido nunca é buscado', () => {
  it('não busca chave que casa a política do robots, mesmo pedida', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const trap = detailPage(FORBIDDEN);

    const records = await source().fetchSkills([FORBIDDEN, FIRST]);

    expect(records.map((record) => record.source_key)).toEqual([FIRST]);
    expect(trap.isDone()).toBe(false);
  });

  it('não segue redirect: um 3xx nunca vira requisição para outro caminho', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE)
      .get(`/${FIRST}`)
      .reply(302, '', { location: `${BASE}/search?q=skills` });
    const followed = nock(BASE).get('/search?q=skills').reply(200, DETAIL_HTML, HTML_HEADERS);

    const records = await source().fetchSkills([FIRST]);

    expect(records).toEqual([]);
    expect(followed.isDone()).toBe(false);
  });

  it('não segue um sitemap que aponta para outro host', async () => {
    const foreign = 'https://evil.test/sitemap-skills-1.xml';
    nock(BASE)
      .get('/sitemap.xml')
      .reply(200, `<sitemapindex><sitemap><loc>${foreign}</loc></sitemap></sitemapindex>`, {
        'content-type': 'application/xml',
      });
    const trap = nock('https://evil.test').get('/sitemap-skills-1.xml').reply(200, SITEMAP_SHARD);

    const records = await source().fetchSkills([FIRST]);

    expect(records).toEqual([]);
    expect(trap.isDone()).toBe(false);
  });
});

describe('failure isolation — página que falha não derruba o run', () => {
  it('um 500 numa chave não impede as outras nem produz métrica null', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST, 500, 'erro');
    detailPage(SECOND);

    const records = await source().fetchSkills([FIRST, SECOND]);

    expect(records.map((record) => record.source_key)).toEqual([SECOND]);
    expect(records.every((record) => record.installs !== null || record.stars !== null)).toBe(true);
  });

  it('erro de rede numa chave é miss, não exceção', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE).get(`/${FIRST}`).replyWithError('socket hang up');
    detailPage(SECOND);

    await expect(source().fetchSkills([FIRST, SECOND])).resolves.toHaveLength(1);
  });

  it('200 com HTML sem identidade é miss — o SPA responde 200 para path inexistente', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE).get(`/${FOURTH}`).reply(200, MISS_HTML, HTML_HEADERS);

    const records = await source().fetchSkills([FOURTH]);

    expect(records).toEqual([]);
  });

  it('página com métrica mas sem nome também é miss', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE)
      .get(`/${THIRD}`)
      .reply(
        200,
        '<!doctype html><html><head><title> </title></head><body><div><span>Installs</span></div><div>4.4M</div></body></html>',
        HTML_HEADERS,
      );

    await expect(source().fetchSkills([THIRD])).resolves.toEqual([]);
  });

  it('chave que já tinha métrica não volta com métrica null quando a página falha', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const adapter = source();

    const first = await adapter.fetchSkills([FIRST]);
    expect(first[0]?.installs).toBe(4_400_000);

    // Mesma instância: o sitemap está em cache; agora a página falha.
    detailPage(FIRST, 503, 'fora do ar');
    const second = await adapter.fetchSkills([FIRST]);

    expect(second).toEqual([]);
  });

  it('a sitemap inteira fora do ar falha o run em vez de fingir catálogo vazio', async () => {
    nock(BASE).get('/sitemap.xml').reply(503, 'fora do ar');

    await expect(source().fetchSkills([FIRST])).rejects.toThrow();
  });
});

describe('catalog module — html wiring', () => {
  it('constrói a fonte html a partir de adapter/baseUrl/rps/clock e a injeta', async () => {
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    const fake = fakeClock();

    const moduleRef = await Test.createTestingModule({
      imports: [
        CatalogModule.forRoot({
          adapter: 'html',
          baseUrl: BASE,
          rps: 1,
          clock: fake.clock,
          repository: stubRepository(),
        }),
      ],
    }).compile();

    expect(moduleRef.get(CATALOG_ADAPTER)).toBe('html');
    const adapter = moduleRef.get<SkillSource>(CATALOG_SOURCE);
    const records = await adapter.fetchSkills([FIRST]);

    expect(records.map((record) => record.source_key)).toEqual([FIRST]);
    expect(fake.sleeps).toEqual([1_000, 1_000]);
  });

  it('recusa o adapter json, que não existe mais', async () => {
    await expect(
      Test.createTestingModule({
        imports: [CatalogModule.forRoot({ adapter: 'json', repository: stubRepository() })],
      }).compile(),
    ).rejects.toThrow(/html|fixture/);
  });
});
