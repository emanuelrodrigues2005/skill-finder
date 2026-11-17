/**
 * Parser da página de detalhe do skills.sh (`docs/app/02-arquitetura.md` §7.2,
 * decisão D3 em `docs/app/amostras/README.md`).
 *
 * O site só publica `Installs`, `GitHub Stars`, `Repository` e `First Seen` como
 * texto renderizado no DOM: rótulo num `<div>` com `<span>`, valor no `<div>`
 * irmão seguinte. O parser é tolerante por contrato — rótulo ausente **não
 * lança**, devolve `null`; a falha prevista é "seletor mudou → métrica `null`",
 * nunca uma exceção que derruba a ingestão inteira.
 *
 * Decodificação em vez de seletor: `<script>`/`<style>` são descartados (o JSON
 * embutido da página contém as mesmas palavras e envenenaria a busca), cada tag
 * vira uma quebra de linha e o valor é a primeira linha não vazia **depois** do
 * rótulo exato. Assim `<div>`/`<span>` extras, classes e atributos não importam.
 */

/** Valores extraídos da página de detalhe; o que não foi encontrado é `null`. */
export interface ParsedDetail {
  /** `4.4M` → `4400000`, `1,234` → `1234`, ilegível → `null`. */
  readonly installs: number | null;
  readonly stars: number | null;
  /** `owner/repo`, como o site escreve. */
  readonly repository: string | null;
  /** Texto cru (`Jan 26, 2026`), não `Date`: quem converte é o adaptador. */
  readonly first_seen: string | null;
}

const LABEL_INSTALLS = 'installs';
const LABEL_STARS = 'github stars';
const LABEL_REPOSITORY = 'repository';
const LABEL_FIRST_SEEN = 'first seen';

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const COUNT_PATTERN = /^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kmb])?$/i;
const MULTIPLIERS: Record<string, number> = { '': 1, k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/** Extrai as quatro métricas da página; nunca lança por conteúdo inesperado. */
export function parseDetailHtml(html: string): ParsedDetail {
  const lines = textLines(html);
  return {
    installs: parseCount(valueAfter(lines, LABEL_INSTALLS)),
    stars: parseCount(valueAfter(lines, LABEL_STARS)),
    repository: valueAfter(lines, LABEL_REPOSITORY),
    first_seen: valueAfter(lines, LABEL_FIRST_SEEN),
  };
}

/** HTML → linhas de texto, sem tags e sem blocos de script/style. */
function textLines(html: string): string[] {
  const withoutCode = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n');
  const withoutTags = withoutCode.replace(/<[^>]*>/g, '\n');
  return withoutTags.split('\n').map((line) => decodeEntities(line).trim());
}

/**
 * Valor do rótulo: primeira linha não vazia imediatamente depois dele. A
 * comparação ignora caixa porque a página aplica `uppercase` por CSS e o texto
 * do DOM pode vir em qualquer caixa — mas é igualdade, não `includes`.
 */
function valueAfter(lines: readonly string[], label: string): string | null {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].toLowerCase() !== label) {
      continue;
    }
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].length > 0) {
        return lines[next];
      }
    }
    return null;
  }
  return null;
}

/** `4.4M` → `4400000`; `abc` → `null`; `0` → `0` (zero não é ausência). */
function parseCount(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const match = COUNT_PATTERN.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const numeric = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.round(numeric * MULTIPLIERS[(match[2] ?? '').toLowerCase()]);
}

function decodeEntities(text: string): string {
  return text.replace(
    /&([a-z]+);/gi,
    (entity, name: string) => ENTITIES[name.toLowerCase()] ?? entity,
  );
}
