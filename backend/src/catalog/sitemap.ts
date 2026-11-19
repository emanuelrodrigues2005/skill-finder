/**
 * Enumeração e montagem de URL do adaptador `html` (#47,
 * `docs/app/02-arquitetura.md` §7.1–7.2).
 *
 * O skills.sh não publica listagem paginada: publica um índice de sitemaps
 * (`/sitemap.xml`) que aponta para shards `sitemap-skills-<n>.xml`, e cada shard
 * lista até 10 000 URLs de página de detalhe (amostra de 2026-11-15 em
 * `docs/app/amostras/`). A chave (`owner/repo/slug`) nasce **só** de URL desse
 * sitemap e a URL buscada é sempre `base fixa + source_key percent-encoded` —
 * nunca uma URL vinda do banco (anti-SSRF).
 *
 * `robots.txt` do site (mesma amostra) é `Allow: /` com `Disallow` em `/search`,
 * `/api/`, `/internal/` e `/debug-security/`. O montador **rejeita** essas rotas
 * aqui, no único lugar que monta URL de saída: o chamador não tem como pedir uma
 * página proibida "por engano".
 *
 * O XML é lido por regex de `<loc>`, não por parser de DOM: o formato do sitemap
 * é fixo, entidades são decodificadas e arquivo malformado devolve lista vazia —
 * nunca uma exceção que derrube a ingestão por causa de um shard estranho.
 */

/** Base default, a mesma da coleta congelada (`docs/app/amostras/README.md`). */
export const DEFAULT_SKILL_SOURCE_BASE_URL = 'https://www.skills.sh';

/**
 * Prefixos que o `robots.txt` do skills.sh proíbe (amostra de 2026-11-15):
 * `/search`, `/api/`, `/internal/` e `/debug-security/`. Sem âncora de fim: o
 * robots trata como prefixo de caminho, e `/search?q=` também está proibido.
 */
export const ROBOTS_DISALLOWED = /^\/(search|api\/|internal|debug-security)/;

/** Caminho de shard de skills aceito no índice: `sitemap-skills-<n>.xml`. */
const SKILLS_SHARD_PATH = /^\/sitemap-skills-\d+\.xml$/;

/** Segmento aceito de `source_key`; tudo fora disso é chave corrompida. */
const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/** `owner/repo/slug` — três segmentos, o formato do site. */
const SOURCE_KEY_SEGMENTS = 3;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** `true` quando o caminho não casa nenhum `Disallow` do robots. */
export function isRobotsAllowed(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return false;
  }
  return !ROBOTS_DISALLOWED.test(path);
}

/** URL do índice de sitemaps sobre a base fixa. */
export function sitemapIndexUrl(baseUrl: string): string {
  return `${originOf(baseUrl)}/sitemap.xml`;
}

/**
 * Shards de skills citados no índice, na ordem do arquivo, só da mesma origem.
 * `misc` e `owners` não são páginas de skill e não entram na enumeração; host
 * estrangeiro é descartado (a lista de shards não escolhe o host a visitar).
 */
export function parseSitemapIndex(xml: string, baseUrl: string): string[] {
  const origin = originOf(baseUrl);
  const shards: string[] = [];
  for (const loc of parseSitemapLocs(xml)) {
    let url: URL;
    try {
      url = new URL(loc);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.username !== '' || url.password !== '') {
      continue;
    }
    if (url.search !== '' || url.hash !== '' || !SKILLS_SHARD_PATH.test(url.pathname)) {
      continue;
    }
    if (!shards.includes(loc)) {
      shards.push(loc);
    }
  }
  return shards;
}

/** Valores de `<loc>` do XML, com entidades decodificadas; lixo devolve `[]`. */
export function parseSitemapLocs(xml: string): string[] {
  if (typeof xml !== 'string' || xml.length === 0) {
    return [];
  }
  const locs: string[] = [];
  const pattern = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let match = pattern.exec(xml);
  while (match !== null) {
    const value = decodeXmlEntities(match[1].trim());
    if (value.length > 0) {
      locs.push(value);
    }
    match = pattern.exec(xml);
  }
  return locs;
}

/**
 * `source_key` de uma URL de página de detalhe, ou `null` quando a URL não é
 * uma página de detalhe da base (outro host, outro formato, query/fragmento,
 * rota proibida pelo robots). É o único caminho pelo qual uma chave nasce do
 * sitemap — nada é inferido de URL arbitrária.
 */
export function sourceKeyFromDetailUrl(url: string, baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== originOf(baseUrl) || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.search !== '' || parsed.hash !== '' || !isRobotsAllowed(parsed.pathname)) {
    return null;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== SOURCE_KEY_SEGMENTS || !segments.every(isSegment)) {
    return null;
  }
  return segments.join('/').toLowerCase();
}

/**
 * Chave canônica (`lowercase`, 3 segmentos, rota permitida) ou `null`. Chave
 * inválida é ausência, nunca exceção: o rodízio não pode cair por dado corrompido.
 */
export function normaliseSourceKey(key: string): string | null {
  try {
    return detailPathFor(key).slice(1);
  } catch {
    return null;
  }
}

/**
 * URL de detalhe da chave: base fixa + `source_key` percent-encoded. Lança para
 * chave malformada, rota proibida pelo robots ou base que não é host puro — o
 * adaptador trata o lançamento como miss daquela chave.
 */
export function detailUrlFor(baseUrl: string, sourceKey: string): string {
  return `${originOf(baseUrl)}${detailPathFor(sourceKey)}`;
}

/** Caminho `/owner/repo/slug` validado contra forma e robots; lança se inválido. */
function detailPathFor(sourceKey: string): string {
  if (typeof sourceKey !== 'string') {
    throw new Error('source_key inválido: esperado string owner/repo/slug');
  }
  const segments = sourceKey.trim().toLowerCase().split('/');
  if (segments.length !== SOURCE_KEY_SEGMENTS || !segments.every(isSegment)) {
    throw new Error(`source_key inválido: ${sourceKey} (esperado owner/repo/slug)`);
  }
  const path = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  if (!isRobotsAllowed(path)) {
    throw new Error(`robots.txt proíbe o caminho ${path}; a URL não é montada`);
  }
  return path;
}

function isSegment(segment: string): boolean {
  return SEGMENT.test(segment);
}

/**
 * Origem da base, exigindo host puro: credenciais, query, fragmento e path
 * transformariam a "base fixa" em URL escolhida por configuração errada.
 */
function originOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`base URL inválida: ${baseUrl}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`base URL inválida (só http/https): ${baseUrl}`);
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error(`base URL deve ser só o host, sem credenciais, query ou path: ${baseUrl}`);
  }
  return url.origin;
}

/** Decodifica entidades XML nomeadas e numéricas (`&amp;`, `&#38;`, `&#x26;`). */
function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return ENTITIES[body.toLowerCase()] ?? entity;
  });
}
