/**
 * Explicação e recomendação determinísticas (decisão D-C).
 *
 * A porta `IntentParser` **não** tem `explain`: a LLM interpreta a consulta e
 * escreve o porquê; o backend resolve os placeholders `{{skill:<skill_id>}}` com
 * o nome vindo do banco. Sem LLM (modo degradado de dev/CI) o texto sai daqui,
 * igual para toda execução — e a resposta avisa com `explanation_from_template`.
 *
 * Regras que os testes fixam:
 * - `explanation` nunca contém `{{` e cabe em 1200 caracteres;
 * - placeholder de id fora do conjunto ranqueado é **removido** e o item ganha
 *   a flag `explanation_repaired` (§5.3);
 * - `caveats` é `null` quando não falta dado e ≤ 160 caracteres quando falta
 *   (dado ausente é `null`, nunca zero — regra 3 do `AGENTS.md`).
 *
 * O `name` é **dado de terceiro** (vem do scraping do catálogo): ele entra no
 * texto sempre escapado por {@link escapePlaceholderSyntax}, para que um nome
 * como `x {{skill:sk_...}}` não seja lido como placeholder — resolvido com o
 * nome de outra skill ou apagado com `explanation_repaired` por causa do dado
 * de terceiro.
 */
import type { SkillSummary } from '../contract/dto/catalog.dto';
import type { Recommendation } from '../contract/dto/search-response.dto';
import type { EvidenceCompleteness, ScoreBreakdown } from '../contract/dto/result-item.dto';

/** Teto do contrato para o texto de um item (§5.3). */
export const MAX_EXPLANATION_CHARS = 1200;

/** Teto do contrato para o aviso de evidência incompleta (§5.3). */
export const MAX_CAVEATS_CHARS = 160;

/** Flag de item (§5.3): o texto precisou de reparo antes de sair. */
export const EXPLANATION_REPAIRED_FLAG = 'explanation_repaired';

/** O que a explicação consome de um item ranqueado. */
export interface ExplanationItem {
  readonly skill: SkillSummary;
  readonly score_breakdown: ScoreBreakdown;
  readonly evidence_completeness: EvidenceCompleteness;
  /** Texto bruto com placeholders; ausente = template determinístico. */
  readonly template?: string;
  /**
   * `caveats` vindo do agente, **com placeholders**. Passa pelo mesmo resolvedor
   * da explicacao: o degrau 5 do `explain-parser` preserva de proposito
   * `{{skill:<id>}}`, e publicar o texto cru colocaria `{{...}}` na interface
   * (achado HIGH do parecer da #42).
   */
  readonly caveatsTemplate?: string | null;
}

/** Resultado pronto para o `ResultItem` do contrato. */
export interface Explanation {
  readonly explanation: string;
  readonly flags: string[];
  readonly caveats: string | null;
}

/**
 * `{{skill:<skill_id>}}` — o único formato de placeholder que o backend resolve.
 *
 * Aceita qualquer coisa entre as chaves para que um placeholder **malformado**
 * também seja removido (e sinalizado), em vez de vazar `{{` para a interface.
 */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

const SKILL_PLACEHOLDER_PREFIX = 'skill:';

function percent(factor: number): string {
  return `${String(Math.round(clamp01(factor) * 100))}%`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Template determinístico de um item: só números do ranking e o nome da skill.
 *
 * Sem relógio, sem aleatoriedade e sem texto externo além do `name` — a mesma
 * entrada produz sempre a mesma frase, que é o que permite comparar execuções.
 *
 * O texto é **pt-BR** como o resto da interface (regra 6 do `AGENTS.md`): sem
 * isto, a tela em português mostraria prosa em inglês. O `name` continua sendo
 * dado da fonte e não é traduzido.
 */
function defaultTemplate(item: ExplanationItem): string {
  const name = escapePlaceholderSyntax(item.skill.name);
  const breakdown = item.score_breakdown;
  const factors =
    `estrelas ${percent(breakdown.stars)}, vulnerabilidades ` +
    `${percent(breakdown.vulnerabilities)}, instalações ${percent(breakdown.installs)}`;

  return breakdown.missing_fields > 0
    ? `${name}: ${factors}. ${String(breakdown.missing_fields)} campo(s) do catálogo estão ` +
        `ausentes, então o score usa valores neutros e uma penalidade de ` +
        `${percent(breakdown.penalty_factor)}.`
    : `${name}: ${factors}. Todos os dados do score vieram do snapshot do catálogo.`;
}

/**
 * Aviso de evidência incompleta (≤ {@link MAX_CAVEATS_CHARS}), ou `null`.
 *
 * Não repete o nome da skill: o `SkillSummary` ao lado já o traz, e um nome
 * patológico estouraria o teto do contrato.
 */
function caveatsFor(item: ExplanationItem): string | null {
  const missing = item.evidence_completeness.missing_fields;
  if (missing <= 0) {
    return null;
  }
  const text =
    `${String(missing)} campo(s) do catálogo ausente(s) para esta skill; o score usa valores ` +
    'neutros e a interface mostra n/a em vez de zero.';
  return text.slice(0, MAX_CAVEATS_CHARS);
}

/**
 * Escapa `{` e `}` de texto **de terceiro** antes de ele entrar na explicação.
 *
 * O `name` de uma skill vem do scraping do catálogo, então não é confiável: sem
 * o escape, `x {{skill:sk_<id>}}` seria resolvido pelo {@link resolvePlaceholders}
 * e o nome de **outra** skill apareceria dentro da explicação deste item — ou,
 * com id fora do conjunto, o trecho seria apagado e o item ganharia
 * `explanation_repaired` por causa do dado de terceiro. O escape também garante
 * o invariante "`explanation` nunca contém `{{`".
 */
function escapePlaceholderSyntax(value: string): string {
  return value.replace(/[{}]/g, '\\$&');
}

/**
 * Resolve os placeholders do texto contra o conjunto ranqueado.
 *
 * Id desconhecido (ou placeholder malformado) é removido e sinalizado: citar uma
 * skill fora do conjunto recuperado é exatamente o que a regra 1 do `AGENTS.md`
 * proíbe a LLM de fazer, e a interface não pode receber um `{{...}}` cru.
 *
 * O `name` substituído também é escapado: ele chega do banco, não do template.
 */
function resolvePlaceholders(
  template: string,
  known: ReadonlyMap<string, string>,
): { text: string; repaired: boolean } {
  let repaired = false;
  const text = template.replace(PLACEHOLDER, (_match: string, body: string) => {
    const inner = body.trim();
    if (inner.toLowerCase().startsWith(SKILL_PLACEHOLDER_PREFIX)) {
      const id = inner.slice(SKILL_PLACEHOLDER_PREFIX.length).trim();
      const name = known.get(id);
      if (name !== undefined) {
        return escapePlaceholderSyntax(name);
      }
    }
    repaired = true;
    return '';
  });

  return { text: collapseSpaces(text), repaired };
}

/** Espaços duplicados e pontuação órfã que a remoção do placeholder pode deixar. */
function collapseSpaces(value: string): string {
  return value
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

/** Corta no teto do contrato sem deixar `{{` partido no fim. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const cut = value.slice(0, maxChars);
  const dangling = cut.lastIndexOf('{{');
  return dangling === -1 ? cut : cut.slice(0, dangling).trimEnd();
}

/**
 * Monta a explicação de um item.
 *
 * @param item item ranqueado, com o texto bruto (se houver) em `template`.
 * @param known `skill_id` -> `name` do conjunto **ranqueado**; qualquer outro id
 *   é tratado como placeholder inválido.
 */
export function explainItem(
  item: ExplanationItem,
  known: ReadonlyMap<string, string>,
): Explanation {
  const raw = item.template?.trim();
  const source = raw !== undefined && raw.length > 0 ? raw : defaultTemplate(item);
  const { text, repaired } = resolvePlaceholders(source, known);

  // Texto que virou vazio (placeholder único e desconhecido) não pode chegar à
  // interface: cai no template determinístico, ainda sinalizado como reparado.
  const body = text.length > 0 ? text : collapseSpaces(defaultTemplate(item));

  // `caveats` do agente passa pelo mesmo resolvedor da explicacao: o degrau 5
  // preserva `{{skill:<id>}}` de proposito, e publicar cru colocaria `{{...}}`
  // na tela (achado HIGH do parecer da #42).
  const rawCaveats = item.caveatsTemplate?.trim();
  const resolvedCaveats =
    rawCaveats === undefined || rawCaveats.length === 0
      ? null
      : resolvePlaceholders(rawCaveats, known);

  return {
    explanation: truncate(body, MAX_EXPLANATION_CHARS),
    flags: repaired ? [EXPLANATION_REPAIRED_FLAG] : [],
    caveats:
      resolvedCaveats !== null && resolvedCaveats.text.length > 0
        ? truncate(resolvedCaveats.text, MAX_CAVEATS_CHARS)
        : caveatsFor(item),
  };
}

/**
 * Recomendação única, em texto, do primeiro item do ranking (§5.3).
 *
 * Passa pelo **mesmo caminho** da explicação: o `name` entra escapado e o texto
 * inteiro é resolvido contra o conjunto — senão um `{{skill:sk_…}}` no nome do
 * top-1 sairia verbatim em `recommendation.text`.
 *
 * `null` para lista vazia: a interface mostra o estado vazio explicado, não uma
 * recomendação sem candidato.
 */
export function recommend(items: readonly ExplanationItem[]): Recommendation | null {
  const [first] = items;
  if (first === undefined) {
    return null;
  }

  const breakdown = first.score_breakdown;
  const reason =
    breakdown.missing_fields > 0
      ? 'lidera o ranking determinístico, com penalidade pelos campos do catálogo ausentes'
      : 'lidera o ranking determinístico em estrelas, vulnerabilidades e instalações';

  const known = new Map(items.map((item) => [item.skill.skill_id, item.skill.name]));
  const { text } = resolvePlaceholders(
    `${escapePlaceholderSyntax(first.skill.name)} é a melhor correspondência para esta busca: ${reason}.`,
    known,
  );

  return {
    skill_id: first.skill.skill_id,
    text: truncate(text, MAX_EXPLANATION_CHARS),
  };
}
