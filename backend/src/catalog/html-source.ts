/**
 * Adaptador `html` — o único adaptador real do catálogo (#47,
 * `docs/app/02-arquitetura.md` §7.1–7.2, decisão D3).
 *
 * Enumeração: `sitemap.xml` → shards `sitemap-skills-<n>.xml`, cada um com até
 * 10 000 URLs de detalhe. Aquisição: uma requisição por `source_key` do shard,
 * mensurada por `SKILL_SOURCE_RPS` (1 req/s na configuração ratificada), que é
 * disciplina nossa — o `robots.txt` não impõe `Crawl-delay`.
 *
 * Regras de segurança que este arquivo implementa:
 *
 * - `robots.txt`: só URL derivada do sitemap é buscada, e `sitemap.ts` recusa
 *   `/search`, `/api/`, `/internal/` e `/debug-security/` no montador. Redirect
 *   não é seguido (`maxRedirects: 0`): seguir um `Location` seria buscar URL
 *   escolhida pelo servidor, fora da enumeração permitida;
 * - SSRF: a URL é sempre `base fixa + source_key percent-encoded`. Chave fora do
 *   sitemap nem é buscada — a chave é a unidade, e ela só nasce de URL do
 *   sitemap (`sourceKeyFromDetailUrl`);
 * - **200 com HTML ≠ existe**: o SPA responde 200 para qualquer caminho. Uma
 *   página só vira registro se o parser extrair identidade — `name` do `<title>`
 *   mais ao menos uma métrica (`installs` ou `stars`). Sem isso é `miss`, nunca
 *   uma linha com métrica `null` que apagaria o que já foi ingerido;
 * - uma página que falha (HTTP, rede ou conteúdo) não derruba o run: o erro é
 *   local àquela chave e ela simplesmente falta no resultado.
 *
 * `fetchSkills(keys)` é a aquisição: uma requisição por chave pedida, cada uma
 * passando pelo limitador. `listKeys()` (#46) é a enumeração do sitemap, usada
 * apenas pelo bootstrap do catálogo vazio; ela **não** busca página de detalhe.
 * Não existe listagem paginada: a aquisição é sempre por chave. `fetchDocument`
 * devolve `null`: buscar `SKILL.md` não é esta issue (as capabilities dizem isso
 * de antemão).
 */
import axios from 'axios';

import { parseDetailHtml } from './html-parser';
import { normaliseSkill, type RawSkill } from './normalise';
import {
  DEFAULT_SKILL_SOURCE_BASE_URL,
  detailUrlFor,
  normaliseSourceKey,
  parseSitemapIndex,
  parseSitemapLocs,
  sitemapIndexUrl,
  sourceKeyFromDetailUrl,
} from './sitemap';
import type {
  CategoryRecord,
  SkillRecord,
  SkillSource,
  SkillSourceCapabilities,
} from './skill-source';

/** `SKILL_SOURCE_RPS` default: 1 requisição por segundo (D3). */
const DEFAULT_RPS = 1;

/**
 * Quanto tempo o indice do sitemap vale antes de ser relido, em ms.
 *
 * 6 h = o intervalo do ciclo do rodizio: o custo e um sitemap por ciclo. Sem
 * expiracao, chave publicada depois do boot nunca seria descoberta.
 */
const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;

/** Teto por requisição: página pesada ou servidor pendurado não trava o ciclo. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Identificação educada do coletor; o site é público e não exige chave. */
const USER_AGENT =
  'skill-finder-catalog/0.1 (+https://github.com/emanuelrodrigues2005/skill-finder)';

const EM_DASH = '\u2014';

const CAPABILITIES: SkillSourceCapabilities = {
  supports_categories: false,
  supports_documents: false,
};

/**
 * Relógio injetável: o teste prova o intervalo de 1 req/s sem `sleep` real, e a
 * produção usa `Date.now` + `setTimeout`.
 */
export interface HtmlSourceClock {
  /** Instante monotônico em milissegundos. */
  now(): number;
  /** Espera `ms`; resolve quando o instante passou. */
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: HtmlSourceClock = {
  now: () => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Opções do adaptador; tudo tem default para o wiring de produção. */
export interface HtmlSourceOptions {
  /** Base fixa (`https://www.skills.sh`); nunca recebe URL de skill do banco. */
  readonly baseUrl?: string;
  /** Requisições por segundo (`SKILL_SOURCE_RPS`); precisa ser > 0. */
  readonly rps?: number;
  /** Timeout de cada requisição em milissegundos. */
  readonly timeoutMs?: number;
  /** Relógio injetado; o default usa o relógio real. */
  readonly clock?: HtmlSourceClock;
}

/** Cria um adaptador `html` independente (cada um com seu relógio e cache). */
export function createHtmlSource(options: HtmlSourceOptions = {}): SkillSource {
  const baseUrl = options.baseUrl ?? DEFAULT_SKILL_SOURCE_BASE_URL;
  const clock = options.clock ?? REAL_CLOCK;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rps = options.rps ?? DEFAULT_RPS;
  if (!Number.isFinite(rps) || rps <= 0) {
    throw new Error(`SKILL_SOURCE_RPS deve ser > 0 (recebido ${String(rps)})`);
  }
  const intervalMs = 1_000 / rps;
  // Valida a base no boot, não na primeira página: configuração errada falha cedo.
  const indexUrl = sitemapIndexUrl(baseUrl);

  // Fila do limitador: a próxima requisição só começa `intervalMs` depois da
  // anterior, e chamadas concorrentes entram na mesma fila. Não é `sleep` fixo:
  // o slot é calculado pelo relógio injetado, então uma chamada que chega
  // atrasada não espera de novo.
  let nextSlot = 0;
  let queue: Promise<void> = Promise.resolve();

  function reserve(): Promise<void> {
    const slot = queue.then(async () => {
      const wait = nextSlot - clock.now();
      if (wait > 0) {
        await clock.sleep(wait);
      }
      nextSlot = clock.now() + intervalMs;
    });
    queue = slot.catch((): void => undefined);
    return slot;
  }

  /** GET de texto (HTML/XML) já passando pelo limitador; sem seguir redirect. */
  async function getText(url: string): Promise<string> {
    await reserve();
    const response = await axios.get<string>(url, {
      responseType: 'text',
      timeout: timeoutMs,
      maxRedirects: 0,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (status: number): boolean => status >= 200 && status < 300,
    });
    return typeof response.data === 'string' ? response.data : String(response.data);
  }

  let keysPromise: Promise<ReadonlySet<string>> | null = null;
  let keysExpiresAt = 0;

  /**
   * Indice de chaves do sitemap, memoizado **com TTL**.
   *
   * Sem TTL, o `Set` era o do primeiro ciclo do processo: chave publicada depois
   * do boot so apareceria no proximo restart, e a descoberta continua da #46
   * dependeria de reinicio (MEDIUM do parecer). Com 4 ciclos/dia, 6 h e o mesmo
   * intervalo do rodizio; o custo e um sitemap por ciclo, nao por chave.
   * Falha na leitura zera o cache: o proximo ciclo tenta de novo.
   */
  function sitemapKeys(): Promise<ReadonlySet<string>> {
    const now = clock.now();
    if (keysPromise !== null && now < keysExpiresAt) {
      return keysPromise;
    }
    keysExpiresAt = now + SITEMAP_TTL_MS;
    keysPromise = loadSitemapKeys().catch((error: unknown) => {
      keysPromise = null;
      keysExpiresAt = 0;
      throw error;
    });
    return keysPromise;
  }

  async function loadSitemapKeys(): Promise<ReadonlySet<string>> {
    const index = await getText(indexUrl);
    const keys = new Set<string>();
    for (const shardUrl of parseSitemapIndex(index, baseUrl)) {
      const shard = await getText(shardUrl);
      for (const loc of parseSitemapLocs(shard)) {
        const key = sourceKeyFromDetailUrl(loc, baseUrl);
        if (key !== null) {
          keys.add(key);
        }
      }
    }
    return keys;
  }

  /** Uma página de detalhe; qualquer falha é miss daquela chave, nunca exceção. */
  async function fetchDetail(key: string): Promise<SkillRecord | null> {
    try {
      const url = detailUrlFor(baseUrl, key);
      return recordFromHtml(await getText(url), url);
    } catch {
      return null;
    }
  }

  return {
    capabilities: CAPABILITIES,
    listCategories: (): Promise<CategoryRecord[]> => Promise.resolve([]),
    fetchSkills: async (keys: readonly string[]): Promise<SkillRecord[]> => {
      // Canônicas e sem repetição, na primeira posição pedida: chave inválida ou
      // repetida é ausência e não chega a gastar requisição.
      const wanted: string[] = [];
      const asked = new Set<string>();
      for (const requested of keys) {
        const key = normaliseSourceKey(requested);
        if (key !== null && !asked.has(key)) {
          asked.add(key);
          wanted.push(key);
        }
      }
      if (wanted.length === 0) {
        return [];
      }
      // Sitemap fora do ar é falha do run (o chamador preserva o catálogo), não
      // "catálogo vazio": por isso o erro sobe em vez de devolver [].
      const known = await sitemapKeys();
      const records: SkillRecord[] = [];
      for (const key of wanted) {
        if (!known.has(key)) {
          // Só chave enumerada pelo sitemap é buscada; o resto é ausência.
          continue;
        }
        const record = await fetchDetail(key);
        if (record !== null) {
          records.push(record);
        }
      }
      return records;
    },
    // Enumeração do `sitemap.xml`, sem buscar nenhuma página de detalhe: é o
    // bootstrap do catálogo vazio (#46). Pode lançar — sitemap fora do ar é
    // falha do run, e o catálogo anterior continua válido.
    listKeys: async (): Promise<string[]> => [...(await sitemapKeys())],
    fetchDocument: (): Promise<null> => Promise.resolve(null),
  };
}

/**
 * Registro a partir da página, ou `null` quando ela não é uma skill de verdade.
 * A identidade exigida é `name` (título antes do em dash) **mais** ao menos uma
 * métrica — o SPA devolve 200 com HTML para caminho inexistente, então status 2xx
 * não prova existência (parecer de segurança da #47).
 */
function recordFromHtml(html: string, url: string): SkillRecord | null {
  const identity = identityFrom(html);
  if (identity === null) {
    return null;
  }
  const parsed = parseDetailHtml(html);
  if (parsed.installs === null && parsed.stars === null) {
    return null;
  }
  const raw: RawSkill = {
    url,
    name: identity.title,
    summary: identity.summary,
    installs: parsed.installs,
    stars: parsed.stars,
    repository: parsed.repository,
    first_seen: parsed.first_seen,
    // D3: a fonte não publica contagem de vulnerabilidades.
    vulnerabilities: null,
  };
  return normaliseSkill(raw);
}

interface Identity {
  /** `<title>` cru, com o sufixo `— owner/repo` que `normaliseSkill` remove. */
  readonly title: string;
  readonly summary: string | null;
}

/** Título e descrição da página; sem título legível não há identidade. */
function identityFrom(html: string): Identity | null {
  const title = nonEmpty(
    decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
  );
  if (title === null || title.split(EM_DASH)[0].trim().length === 0) {
    return null;
  }
  return { title, summary: descriptionFrom(html) };
}

/** `<meta name="description" content="...">`, em qualquer ordem de atributos. */
function descriptionFrom(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (attributeOf(tag, 'name')?.toLowerCase() !== 'description') {
      continue;
    }
    const content = attributeOf(tag, 'content');
    if (content !== null) {
      const decoded = nonEmpty(decodeHtmlEntities(content));
      if (decoded !== null) {
        return decoded;
      }
    }
  }
  return null;
}

/** Valor de um atributo simples (`name="..."` ou `name='...'`) dentro da tag. */
function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  if (match === null) {
    return null;
  }
  return match[1] ?? match[2] ?? '';
}

/** Texto aparado, ou `null` quando só há espaço — ausência nunca é `''`. */
function nonEmpty(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Entidades HTML que aparecem em `<title>`/`meta`: nomeadas e numéricas. */
function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return entities[body.toLowerCase()] ?? entity;
  });
}
