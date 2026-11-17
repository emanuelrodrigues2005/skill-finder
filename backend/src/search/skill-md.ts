/**
 * `SKILL.md` -> trecho de texto puro (§5.4).
 *
 * O contrato de `GET /api/v1/skills/{skill_id}` promete `skill_md_excerpt` com
 * **no máximo 600 caracteres, sem markdown cru**, e a interface renderiza o
 * valor escapado — nunca como HTML. Por isso a conversão é conservadora: ela
 * remove a marcação em vez de tentar renderizá-la, e o texto externo continua
 * sendo dado não confiável (regra 2 do `AGENTS.md`).
 *
 * Só o adaptador Postgres usa isto: o duplo em memória entrega o trecho pronto.
 */

/** Teto do contrato para `skill_md_excerpt` (§5.4). */
export const MAX_EXCERPT_CHARS = 600;

/** Teto do contrato para `summary` (§5.4) — a ingestão já trunca, isto é a rede. */
export const MAX_SUMMARY_CHARS = 280;

/**
 * Converte markdown em texto corrido e corta em {@link MAX_EXCERPT_CHARS}.
 *
 * O corte acontece **depois** da limpeza: medir antes deixaria um trecho cheio de
 * `#` e `[]()` que não cabe mais no teto depois de limpo.
 */
export function skillMdExcerpt(markdown: string, maxChars: number = MAX_EXCERPT_CHARS): string {
  const plain = toPlainText(markdown);
  return plain.length <= maxChars ? plain : cutAtWord(plain, maxChars).trimEnd();
}

/** Resumo de uma linha, sem marcação, para o campo `summary`. */
export function plainSummary(text: string, maxChars: number = MAX_SUMMARY_CHARS): string {
  const plain = toPlainText(text);
  return plain.length <= maxChars ? plain : cutAtWord(plain, maxChars).trimEnd();
}

/**
 * Remove cercas de código, títulos, ênfase, links, imagens e tags HTML.
 *
 * Blocos de código são descartados por inteiro: eles não são prosa e um trecho
 * cortado no meio de um `docker run` não ajuda ninguém.
 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Corta no último espaço antes do teto, para não partir uma palavra ao meio. */
function cutAtWord(value: string, maxChars: number): string {
  const cut = value.slice(0, maxChars);
  const boundary = cut.search(/\s\S*$/);
  return boundary === -1 ? cut : cut.slice(0, boundary);
}
