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
 * - chave fora do sitemap não é buscada (a base é fixa + `source_key` do sitemap);
 * - índice vazio é enumeração vazia (nada de shard) e **3xx no índice** não é
 *   seguido: sitemap inacessível é falha do run, nunca "catálogo vazio";
 * - o limitador é **uma fila por instância**: duas `fetchSkills` simultâneas
 *   recebem slots de 1 s, nunca dois GETs no mesmo instante;
 * - entidades HTML do `<title>`/`<meta>` são decodificadas (nome e resumo são
 *   dado da fonte, mostrados como publicados), e código fora do Unicode fica
 *   literal em vez de virar caractere inventado.
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
import axios from 'axios';
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

/**
 * Página mínima com identidade (`<title>`) e **uma** métrica — o formato que
 * `recordFromHtml` exige. Existe para os casos de entidade HTML e de resumo
 * ausente, onde o resto do markup é ruído.
 */
function minimalPage(head: { title: string; description?: string | null }): string {
  const meta =
    head.description === undefined || head.description === null
      ? ''
      : `<meta name="description" content="${head.description}">`;
  return (
    '<!doctype html><html lang="en"><head>' +
    `<title>${head.title}</title>${meta}` +
    '</head><body><div><span>Installs</span></div><div>4.4M</div></body></html>'
  );
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
    selectUnseenKeys: fail,
    upsertSkills: fail,
    deactivateSkillsStaleBefore: fail,
  };
}

afterEach(() => {
  nock.cleanAll();
  // Cinto e suspensório dos timers falsos: um caso que estoure o `timeout` do
  // Jest não roda o `finally`, e o relógio falso vazaria para as outras suítes.
  jest.useRealTimers();
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

  /**
   * O `<title>` é texto HTML, não texto puro: `&#233;` e `&#x2b;` são a forma que
   * o SSR usa para acento e sinal. Sem decodificar, o `name` publicado sairia com
   * a entidade crua — e é esse valor que a interface mostra (`name` não é
   * traduzido nem reescrito, regra 6).
   */
  it('decodifica entidades numéricas do título antes de virar nome', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE)
      .get(`/${FIRST}`)
      .reply(
        200,
        minimalPage({ title: 'caf&#233; &#x2b; find-skills &amp; cia — vercel-labs/skills' }),
        HTML_HEADERS,
      );

    const records = await source().fetchSkills([FIRST]);

    expect(records[0]?.name).toBe('café + find-skills & cia');
    // Sem `<meta name="description">` o resumo é ausência, nunca `''`.
    expect(records[0]?.summary).toBeNull();
  });

  /**
   * Código fora do Unicode (`&#x110000;`) não é code point: a entidade fica
   * literal em vez de virar caractere inventado ou derrubar a página. A chave
   * continua sendo um registro válido, porque identidade e métrica existem.
   */
  it('entidade fora do Unicode fica literal no título, sem derrubar a página', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE)
      .get(`/${FIRST}`)
      .reply(200, minimalPage({ title: 'find&#x110000;skills — vercel-labs/skills' }), HTML_HEADERS);

    const records = await source().fetchSkills([FIRST]);

    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe('find&#x110000;skills');
  });

  /**
   * `<meta name="description">` em branco (ou sem `content`) não é resumo: vira
   * `null`. `summary: ''` violaria a regra 3 ("dado ausente é `null`, nunca
   * zero") e pintaria um resumo vazio na interface.
   */
  it('meta description em branco ou sem content é ausência, não resumo vazio', async () => {
    sitemapIndex();
    sitemapShard();
    nock(BASE)
      .get(`/${FIRST}`)
      .reply(
        200,
        minimalPage({ title: 'find-skills — vercel-labs/skills', description: '   ' }),
        HTML_HEADERS,
      );
    nock(BASE)
      .get(`/${SECOND}`)
      .reply(
        200,
        '<!doctype html><html><head><title>ai-video-generation — inference-sh/skills</title>' +
          '<meta name="description"></head><body><div><span>Installs</span></div><div>4.4M</div></body></html>',
        HTML_HEADERS,
      );

    const records = await source().fetchSkills([FIRST, SECOND]);

    expect(records.map((record) => record.source_key)).toEqual([FIRST, SECOND]);
    expect(records[0]?.summary).toBeNull();
    expect(records[1]?.summary).toBeNull();
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

  /**
   * Issue #46 — `listKeys()` é a enumeração do sitemap, o bootstrap do catálogo
   * vazio. Ela devolve **chaves**, não registros: nenhuma página de detalhe é
   * buscada aqui, porque quem busca é `fetchSkills(keys)`, passando pelo
   * limitador.
   */
  it('listKeys enumera o sitemap sem buscar página de detalhe', async () => {
    sitemapIndex();
    sitemapShard();
    const trap = nock(BASE).get(`/${FIRST}`).reply(200, minimalPage({ title: 'find-skills' }));

    const keys = await source().listKeys();

    // As 4 chaves do shard da amostra, na ordem do sitemap.
    expect(keys).toEqual([FIRST, SECOND, THIRD, FOURTH]);
    expect(trap.isDone()).toBe(false);
  });

  it('listKeys repassa a falha do sitemap: fora do ar não é catálogo vazio', async () => {
    nock(BASE).get('/sitemap.xml').reply(503, 'indisponível');

    await expect(source().listKeys()).rejects.toThrow();
  });

  it('não expõe mais a listagem paginada: fetchCatalog saiu na #46', () => {
    expect('fetchCatalog' in source()).toBe(false);
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

  /**
   * Concorrência na **mesma instância** (`html-source.ts:119-129`): duas
   * `fetchSkills` simultâneas dividem a mesma fila, então o intervalo de 1 req/s
   * vale por requisição, não por chamada. Sem a fila, as duas buscariam o sitemap
   * (e as páginas) no mesmo instante e o site receberia o dobro de tráfego.
   *
   * O instante é medido na **entrada** de cada GET (espião no `axios.get`, que
   * roda logo depois do `reserve`): o intervalo entre duas requisições quaisquer
   * nunca pode ser menor que 1 s, na ordem em que saíram.
   */
  it('duas fetchSkills simultâneas dividem a fila: nenhuma dupla de requisições no mesmo instante', async () => {
    const fake = fakeClock(0);
    sitemapIndex();
    sitemapShard();
    detailPage(FIRST);
    detailPage(SECOND);

    type GetFn = (url: string, config?: Record<string, unknown>) => Promise<unknown>;
    // `.bind`: a regra `unbound-method` esta certa - `axios.get` separado do
    // objeto perde o `this`.
    const original = axios.get.bind(axios) as unknown as GetFn;
    const instants: number[] = [];
    const spy = jest.spyOn(axios, 'get').mockImplementation((url: string, config?: unknown) => {
      instants.push(fake.now());
      return original(url, config as Record<string, unknown> | undefined);
    });

    try {
      const adapter = createHtmlSource({ baseUrl: BASE, rps: 1, clock: fake.clock });
      const [firstRun, secondRun] = await Promise.all([
        adapter.fetchSkills([FIRST]),
        adapter.fetchSkills([SECOND]),
      ]);

      expect(firstRun.map((record) => record.source_key)).toEqual([FIRST]);
      expect(secondRun.map((record) => record.source_key)).toEqual([SECOND]);
      // Índice (memoizado: uma vez para as duas chamadas), shard e as duas páginas.
      expect(instants).toHaveLength(4);
      for (let index = 1; index < instants.length; index += 1) {
        expect(instants[index] - instants[index - 1]).toBeGreaterThanOrEqual(1_000);
      }
      // Duas chamadas concorrentes = três esperas: a fila é única, não uma por
      // invocação (o que permitiria duas requisições no mesmo slot).
      expect(fake.sleeps).toEqual([1_000, 1_000, 1_000]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * **Não coberto aqui — de propósito:** o `REAL_CLOCK` default do adaptador
   * (`Date.now` + `setTimeout(resolve, ms)`, `html-source.ts:79-85`). Exercitá-lo
   * exige uma espera real de 1 s por requisição, proibida pelo brief ("nada de
   * sleep real"), ou timers falsos globais — e o `nock`/`axios` desta suíte não
   * completa a resposta HTTP com `setTimeout`/`Date` falseados (medido: estouro do
   * timeout de 5 s do Jest). O caminho de produção é o mesmo `reserve()` provado
   * acima com o relógio injetado; o que fica sem prova é só o par
   * `Date.now`/`setTimeout` do relógio real, não a disciplina de intervalo.
   */
});

describe('enumeração — índice de sitemap', () => {
  /**
   * Índice **vazio** é enumeração vazia, não erro: nada de shard é pedido e
   * nenhuma chave pedida é buscada. O run do chamador decide o destino (a
   * ingestão marca `partial/EMPTY_CATALOG`), o adaptador só não inventa página.
   */
  it('índice sem nenhum shard de skills: nenhuma requisição de shard ou de página', async () => {
    const index = nock(BASE)
      .get('/sitemap.xml')
      .reply(
        200,
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          '<sitemap><loc>https://www.skills.sh/sitemap-misc.xml</loc></sitemap>' +
          '</sitemapindex>',
        { 'content-type': 'application/xml' },
      );
    const shardTrap = nock(BASE).get('/sitemap-skills-1.xml').reply(200, SITEMAP_SHARD);
    const pageTrap = detailPage(FIRST);

    const records = await source().fetchSkills([FIRST]);

    expect(records).toEqual([]);
    expect(index.isDone()).toBe(true);
    expect(shardTrap.isDone()).toBe(false);
    expect(pageTrap.isDone()).toBe(false);
  });

  /**
   * O índice também não segue redirect (`maxRedirects: 0`): seguir o `Location`
   * seria visitar uma URL escolhida pelo servidor, fora da enumeração. O erro sobe
   * — "sitemap inacessível" é falha do run, nunca "catálogo vazio".
   */
  it('3xx no índice não é seguido: o run falha em vez de virar catálogo vazio', async () => {
    nock(BASE)
      .get('/sitemap.xml')
      .reply(302, '', { location: `${BASE}/sitemap-skills-1.xml` });
    const followed = nock(BASE).get('/sitemap-skills-1.xml').reply(200, SITEMAP_SHARD);

    await expect(source().fetchSkills([FIRST])).rejects.toThrow();
    expect(followed.isDone()).toBe(false);
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
