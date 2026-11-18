/**
 * Issue #47 — montador de URL e leitura de sitemap do adaptador `html`.
 *
 * Contrato exigido de `backend/src/catalog/sitemap.ts`:
 *
 *   export const DEFAULT_SKILL_SOURCE_BASE_URL = 'https://www.skills.sh';
 *   export function isRobotsAllowed(path: string): boolean;
 *   export function sitemapIndexUrl(baseUrl: string): string;
 *   export function parseSitemapIndex(xml: string, baseUrl: string): string[];
 *   export function parseSitemapLocs(xml: string): string[];
 *   export function sourceKeyFromDetailUrl(url: string, baseUrl: string): string | null;
 *   export function normaliseSourceKey(key: string): string | null;
 *   export function detailUrlFor(baseUrl: string, sourceKey: string): string;
 *
 * Regras que este arquivo prova (parecer de segurança da #47):
 *
 * - `robots.txt` do skills.sh (amostra de 2026-11-15, `docs/app/amostras/robots.txt`)
 *   permite `Allow: /` e proíbe `/search`, `/api/`, `/internal/` e `/debug-security/`.
 *   O montador **rejeita** essas rotas em vez de confiar no chamador;
 * - a URL buscada é sempre `base fixa + source_key percent-encoded`, nunca uma URL
 *   vinda do banco (anti-SSRF);
 * - `source_key` só nasce de URL do sitemap: outro host, outro formato de path ou
 *   query/fragmento viram `null` — ausência, não chave inventada;
 * - o índice só entrega shards `sitemap-skills-<n>.xml` da mesma origem; `misc` e
 *   `owners` não são páginas de skill e não entram na enumeração.
 */
import {
  DEFAULT_SKILL_SOURCE_BASE_URL,
  detailUrlFor,
  isRobotsAllowed,
  normaliseSourceKey,
  parseSitemapIndex,
  parseSitemapLocs,
  sitemapIndexUrl,
  sourceKeyFromDetailUrl,
} from '@/catalog/sitemap';

const BASE = 'https://www.skills.sh';
const KEY = 'vercel-labs/skills/find-skills';

describe('sitemap — montador da URL de detalhe', () => {
  it('monta a URL a partir da base fixa e do source_key', () => {
    expect(detailUrlFor(BASE, KEY)).toBe(`${BASE}/${KEY}`);
  });

  it('aceita base com barra final sem duplicar a barra', () => {
    expect(detailUrlFor(`${BASE}/`, KEY)).toBe(`${BASE}/${KEY}`);
  });

  it('rejeita base com credenciais, query ou path — a base é host fixo', () => {
    expect(() => detailUrlFor('https://user:senha@www.skills.sh', KEY)).toThrow(/base/i);
    expect(() => detailUrlFor(`${BASE}?x=1`, KEY)).toThrow(/base/i);
    expect(() => detailUrlFor(`${BASE}/prefixo`, KEY)).toThrow(/base/i);
  });

  it('normaliza caixa e espaços do source_key antes de montar', () => {
    expect(detailUrlFor(BASE, '  Vercel-Labs/Skills/Find-Skills ')).toBe(`${BASE}/${KEY}`);
  });
});

describe('robots — caminho proibido nunca vira URL', () => {
  it.each([
    ['/search'],
    ['/search?q=skills'],
    ['/api/v1/skills'],
    ['/internal/health'],
    ['/debug-security/probe'],
  ])('recusa o caminho %s', (path) => {
    expect(isRobotsAllowed(path)).toBe(false);
  });

  it.each([['/'], [`/${KEY}`], ['/sitemap.xml']])('permite o caminho %s', (path) => {
    expect(isRobotsAllowed(path)).toBe(true);
  });

  /**
   * `search`, `api`, `internal` e `debug-security` como primeiro segmento são
   * recusados mesmo quando a chave tem a forma `owner/repo/slug`: a rota é
   * proibida pelo robots e o adaptador não pode buscá-la nem por engano.
   */
  it.each([
    ['search/qualquer/coisa'],
    ['api/v1/skills'],
    ['internal/health/check'],
    ['debug-security/probe/page'],
    ['SEARCH/qualquer/coisa'],
  ])('recusa a chave %s e não monta URL', (key) => {
    expect(() => detailUrlFor(BASE, key)).toThrow(/robots/i);
  });

  it.each([
    [''],
    ['a/b'],
    ['a/b/c/d'],
    ['../etc/passwd'],
    ['a/../b'],
    ['a//b'],
    ['https://evil.test/a/b/c'],
    ['a/b c'],
    ['a/b%2fc'],
    ['a/b/c?x=1'],
  ])('recusa a chave malformada %s', (key) => {
    expect(() => detailUrlFor(BASE, key)).toThrow();
  });

  it('só monta caminho com segmentos [a-z0-9._-] — nada a percent-encodar', () => {
    const url = detailUrlFor(BASE, KEY);

    expect(url).toBe(encodeURI(url));
  });
});

describe('sitemap — enumeração', () => {
  it('o índice é /sitemap.xml sobre a base', () => {
    expect(sitemapIndexUrl(BASE)).toBe(`${BASE}/sitemap.xml`);
  });

  it('mantém só os shards de skills da mesma origem, na ordem do arquivo', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '<sitemap><loc>https://www.skills.sh/sitemap-misc.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-owners.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills-1.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills-2.xml</loc></sitemap>',
      '</sitemapindex>',
    ].join('\n');

    expect(parseSitemapIndex(xml, BASE)).toEqual([
      'https://www.skills.sh/sitemap-skills-1.xml',
      'https://www.skills.sh/sitemap-skills-2.xml',
    ]);
  });

  it('ignora host estrangeiro, caminho parecido e shard repetido', () => {
    const xml = [
      '<sitemap><loc>https://evil.test/sitemap-skills-1.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills-1.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills-1.xml</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills-1.xml.bak</loc></sitemap>',
      '<sitemap><loc>https://www.skills.sh/sitemap-skills.xml</loc></sitemap>',
    ].join('\n');

    expect(parseSitemapIndex(xml, BASE)).toEqual(['https://www.skills.sh/sitemap-skills-1.xml']);
  });

  it('decodifica entidades do XML e ignora lixo sem lançar', () => {
    const xml = '<urlset><url><loc>https://www.skills.sh/a/b/c?x=1&amp;y=2</loc></url></urlset>';

    expect(parseSitemapLocs(xml)).toEqual(['https://www.skills.sh/a/b/c?x=1&y=2']);
    expect(parseSitemapLocs('não é xml')).toEqual([]);
    expect(parseSitemapLocs('')).toEqual([]);
  });
});

describe('sitemap — source_key só nasce de URL de detalhe da própria base', () => {
  it('deriva a chave de 3 segmentos lowercase do path', () => {
    expect(sourceKeyFromDetailUrl(`${BASE}/Vercel-Labs/Skills/Find-Skills`, BASE)).toBe(KEY);
  });

  it.each([
    ['https://evil.test/vercel-labs/skills/find-skills'],
    ['https://www.skills.sh/sitemap-skills-1.xml'],
    ['https://www.skills.sh/search?q=skills'],
    ['https://www.skills.sh/api/v1/skills'],
    ['https://www.skills.sh/internal/health/check'],
    [`${BASE}/${KEY}?x=1`],
    [`${BASE}/${KEY}#topo`],
    [`${BASE}/a/b`],
    ['javascript:alert(1)'],
    [''],
  ])('devolve null para a URL %s', (url) => {
    expect(sourceKeyFromDetailUrl(url, BASE)).toBeNull();
  });

  it('a chave normalizada é o que o índice guarda', () => {
    expect(normaliseSourceKey(` ${KEY.toUpperCase()} `)).toBe(KEY);
    expect(normaliseSourceKey('a/b')).toBeNull();
    expect(normaliseSourceKey('search/x/y')).toBeNull();
  });
});

describe('sitemap — amostra congelada', () => {
  // A base default é a mesma da coleta de 2026-11-15 (`docs/app/amostras/README.md`).
  it('a base default é a do skills.sh', () => {
    expect(DEFAULT_SKILL_SOURCE_BASE_URL).toBe(BASE);
  });
});
