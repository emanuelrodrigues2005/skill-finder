/**
 * Normalização do formato do site para o formato interno
 * (`docs/app/02-arquitetura.md` §7.1, mapa campo → origem em
 * `docs/app/amostras/README.md`).
 *
 * Regras ratificadas que este arquivo implementa:
 * - `summary` cortado em **280** e `skill_md_excerpt` em **600**, corte puro,
 *   sem reticências acrescentadas (a elipse do site, quando existe, já vem no
 *   texto original);
 * - `source_key` = 3 primeiros segmentos do **path** da URL, lowercase, sem
 *   query nem fragmento;
 * - `name` = texto antes do primeiro em dash (U+2014); se esvaziar, o último
 *   segmento do `source_key`;
 * - URL só `https://` absoluta: `http:`, `javascript:`, `data:` e `//host` viram
 *   `null` (`httpsUrlOrNull`);
 * - dado ausente é `null`, nunca `0`; `vulnerability_count` é **sempre** `null`
 *   (D3) e `repo_url` é **sempre** `null` — a fonte não publica nem um nem
 *   outro, e sintetizar URL de repositório seria inventar dado.
 */
import type { DocumentRecord, SkillRecord } from './skill-source';

/** Limite de `skill.summary` (D3). */
export const SUMMARY_LIMIT = 280;

/** Limite de `skill_md_excerpt` enviado ao prompt/armazenado (§7.5). */
export const EXCERPT_LIMIT = 600;

const EM_DASH = '\u2014';
const HTTPS_PREFIX = 'https://';
const SOURCE_KEY_SEGMENTS = 3;

/** Formato do site (`skills.sh`), o mesmo da amostra congelada: snake_case. */
export interface RawSkill {
  readonly url: string;
  readonly name?: string | null;
  readonly summary?: string | null;
  readonly installs?: number | null;
  readonly stars?: number | null;
  readonly repository?: string | null;
  readonly first_seen?: string | null;
  readonly vulnerabilities?: number | null;
}

/** `SKILL.md` cru, como o adaptador o obteve. */
export interface RawDocument {
  readonly source_key: string;
  readonly markdown: string;
}

/**
 * Aceita apenas URL `https://` absoluta e devolve o valor **inalterado**
 * (a query e o fragmento são preservados; só o `source_key` os descarta).
 * Qualquer outro esquema — inclusive `HTTPS://`, que não é o literal aceito —
 * vira `null`, e `null` é o valor que a coluna recebe.
 */
export function httpsUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (!value.startsWith(HTTPS_PREFIX)) {
    return null;
  }
  // `https://` sozinho não é URL; espaço nas bordas é ruído de scraping.
  if (value.length <= HTTPS_PREFIX.length || value.trim() !== value) {
    return null;
  }
  return value;
}

/** Normaliza uma skill crua do site para o registro interno. */
export function normaliseSkill(raw: RawSkill): SkillRecord {
  const sourceKey = sourceKeyFromUrl(raw.url);
  return {
    source_key: sourceKey,
    source_url: httpsUrlOrNull(raw.url),
    name: nameFrom(raw.name, sourceKey),
    summary: clampText(raw.summary, SUMMARY_LIMIT),
    category_slug: null,
    stars: numberOrNull(raw.stars),
    installs: numberOrNull(raw.installs),
    // D3: a fonte não publica o número. Nem quando o objeto cru traz um.
    vulnerability_count: null,
    security_status: 'unknown',
    // A fonte entrega `owner/repo`, não a URL: não sintetizar.
    repo_url: null,
    skill_md_present: false,
    first_seen_at: dateOrNull(raw.first_seen),
    raw,
  };
}

/** Normaliza um `SKILL.md` cru para o registro interno. */
export function normaliseDocument(raw: RawDocument): DocumentRecord {
  return {
    source_key: raw.source_key,
    skill_md_excerpt: clampText(raw.markdown, EXCERPT_LIMIT),
  };
}

/** Corte puro em `limit`; texto ausente ou só espaço é `null`, nunca `''`. */
function clampText(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, limit);
}

/** Texto antes do primeiro em dash; vazio cai no último segmento da chave. */
function nameFrom(rawName: string | null | undefined, sourceKey: string): string {
  const title = typeof rawName === 'string' ? rawName : '';
  const beforeDash = title.split(EM_DASH)[0].trim();
  if (beforeDash.length > 0) {
    return beforeDash;
  }
  return sourceKey.split('/').at(-1) ?? '';
}

/**
 * `source_key` a partir do path da URL: 3 segmentos, lowercase, sem query nem
 * fragmento. `new URL` já descarta busca e hash; a URL sem esquema (que a
 * normalização não deveria receber, mas pode) é tratada como caminho cru.
 */
function sourceKeyFromUrl(url: string): string {
  return pathOf(url)
    .split('/')
    .filter((segment) => segment.length > 0)
    .slice(0, SOURCE_KEY_SEGMENTS)
    .join('/')
    .toLowerCase();
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
      .replace(/^[a-z][a-z0-9+.-]*:/i, '')
      .replace(/[?#].*$/, '');
  }
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Texto de data do site (`Jan 26, 2026`) para `Date`. Ilegível vira `null`: a
 * coluna é obrigatória, e quem insere decide o fallback (`seenAt`).
 */
function dateOrNull(value: string | null | undefined): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}
