/**
 * Porta `explain` e a escada de validação (`docs/app/02-arquitetura.md` §6.5).
 *
 * A LLM escreve **o porquê** de cada candidato e destaca o `rank 1`; ela não
 * ordena, não pontua e não cita skill fora do conjunto recuperado (regra 1 do
 * `AGENTS.md`). O texto é dado não confiável (regra 2): nada do modelo chega à
 * resposta sem passar pela escada abaixo, e o que não passa deixa o #42 no
 * template determinístico de `src/search/explanation.ts`.
 *
 * A escada, degrau por degrau — cada um com o próprio desfecho:
 *
 *   1. corpo que não é JSON, ou com chave fora do schema -> `invalid_json`;
 *   2. `skill_id` fora dos candidatos (enum no schema **e** pós-checagem) -> item
 *      descartado; menos de um sobrevivente -> `invalid_ids`;
 *   3. `recommendation.skill_id` diferente do `rank 1` -> **um** reparo (o
 *      re-prompt sai de `explain-prompt.ts`); persistindo -> `invalid_ids`;
 *   4. tetos 320/160/400 -> trunca, sem partir `{{` e **sem** invalidar o passo;
 *   5. nome de skill só via `{{skill:<id>}}` do conjunto: desconhecido ou mal
 *      formado é removido e o item sai com `repaired: true` — é dele que o #42 tira
 *      a flag `explanation_repaired` do §5.3;
 *   6. corpo fixo (`tools: []`, `temperature`, `max_tokens`) — em `openai-compat.ts`.
 *
 * **O status do contrato não ganha valor novo** (§6.3: `LlmStatus` é fechado):
 * `invalid_json` é o rótulo da métrica `llm_calls_total{status="invalid_json"}`, e
 * na resposta o degrau 1 aparece como `unavailable` — o mesmo mapeamento que o
 * passo de intenção já faz para corpo fora do schema (`IntentPayloadError`). O
 * motivo fica em {@link ExplainResult.reason} para a observabilidade, sem tocar no
 * enum congelado.
 *
 * Orçamento de latência (F2.10, `LLM_TOTAL_DEADLINE_MS = 7000`): a intenção
 * recebe `min(3000, restante)` e a explicação `min(4000, restante)`; com menos de
 * {@link EXPLAIN_MIN_BUDGET_MS} a explicação **não é tentada** e `explain_status`
 * fica `null` — ausência de tentativa, não falha (§6.3).
 */
import { z } from 'zod';

import type { ExplainItem, ExplainRecommendation } from '@/contract/dto/explain.dto';
import type { Intent, LlmStatus, TokenUsage } from '@/contract/dto/search-response.dto';

/** Teto do contrato para o `why` de um item (`ExplainItem.why`, §6.5). */
export const MAX_WHY_CHARS = 320;

/** Teto do contrato para `caveats` (§6.5). */
export const MAX_CAVEATS_CHARS = 160;

/** Teto do contrato para o `why` da recomendação (§6.5). */
export const MAX_RECOMMENDATION_CHARS = 400;

/**
 * Teto de tempo do passo de intenção dentro do orçamento total (F2.10).
 *
 * Os três números do orçamento vivem juntos de propósito: são uma mesma política
 * (quanto cada etapa pode consumir do teto `LLM_TOTAL_DEADLINE_MS`) e separá-los
 * faz um ajuste num passo mentir sobre o outro.
 */
export const INTENT_STEP_MAX_MS = 3_000;

/** Teto de tempo do passo de explicação dentro do orçamento total (F2.10). */
export const EXPLAIN_STEP_MAX_MS = 4_000;

/**
 * Abaixo disso a explicação não vale a chamada: o usuário já esperou o orçamento
 * inteiro e o template é mais rápido do que uma ida ao provedor.
 */
export const EXPLAIN_MIN_BUDGET_MS = 800;

/** Um candidato ranqueado, na forma que o prompt e a validação consomem (§6.5). */
export interface ExplainCandidate {
  readonly skill_id: string;
  readonly name: string;
  readonly category: string | null;
  readonly stars: number | null;
  readonly installs: number | null;
  readonly vulnerability_count: number | null;
  readonly summary: string | null;
  /** Trecho do `SKILL.md` (≤ 1500 caracteres), quando já baixado (§7.5). */
  readonly skill_md_excerpt?: string | null;
}

/** Pedido de explicação: a consulta, a intenção e o conjunto **já ranqueado**. */
export interface ExplainRequest {
  readonly query: string;
  readonly intent: Intent;
  /** Candidatos na ordem do ranking; `candidates[0]` é o `rank 1` (§6.5). */
  readonly candidates: readonly ExplainCandidate[];
  /**
   * Snapshot do catálogo (`data.catalog_snapshot`). Entra na chave do cache de
   * explicação: a prosa cita estrelas/instalações, e servir a mesma prosa depois
   * de um ciclo de ingestão entregaria números vencidos (§4.1). Ausente, o cache
   * cai no comportamento antigo — a #42 tem de passar.
   */
  readonly catalog_snapshot?: string;
  /**
   * Instante (epoch ms) em que o orçamento total da busca expira. Ausente, vale
   * `agora + LLM_TOTAL_DEADLINE_MS` do cliente.
   */
  readonly deadlineAtMs?: number;
}

/**
 * Por que o passo não entregou prosa — para métrica e log, **fora** do contrato.
 *
 * `invalid_json`/`invalid_ids` vêm da escada; `timeout`/`provider_error` do
 * provedor; `budget`/`no_candidates`/`disabled` são ausência de tentativa
 * (`explain_status: null`).
 */
export type ExplainReason =
  | 'invalid_json'
  | 'invalid_ids'
  | 'timeout'
  | 'provider_error'
  | 'budget'
  | 'no_candidates'
  | 'disabled';

/** Item explicado: o payload do contrato + o sinal de reparo deste item. */
export interface ExplainedItem extends ExplainItem {
  /** `true` quando o texto precisou de reparo (placeholder removido ou truncado). */
  readonly repaired: boolean;
}

/** Recomendação explicada, com o mesmo sinal de reparo. */
export interface ExplainedRecommendation extends ExplainRecommendation {
  readonly repaired: boolean;
}

/** O que a porta devolve para a busca. */
export interface ExplainResult {
  /** Itens validados; vazio quando o passo não entregou prosa. */
  readonly items: readonly ExplainedItem[];
  /** Destaque do `rank 1`; `null` quando o passo não entregou prosa. */
  readonly recommendation: ExplainedRecommendation | null;
  /**
   * Desfecho no enum do contrato (`LlmStatus`); `null` quando o passo **não foi
   * tentado** — com `LLM_ENABLED=false`, sem orçamento ou sem candidato.
   */
  readonly status: LlmStatus | null;
  /** Motivo, para métrica; `null` quando o passo entregou prosa. */
  readonly reason: ExplainReason | null;
  /** Modelo que respondeu; `null` quando não houve chamada ao provedor. */
  readonly model: string | null;
  /** Tokens cobrados; `null` quando não houve chamada ao provedor. */
  readonly tokens: TokenUsage | null;
}

/** Porta do passo de explicação, injetada por DI (regra 5 do `AGENTS.md`). */
export interface ExplainParser {
  explain(request: ExplainRequest): Promise<ExplainResult>;
}

/** Contexto da validação: só o conjunto ranqueado, nada além dele. */
export interface ExplainPayloadContext {
  readonly candidates: readonly ExplainCandidate[];
}

/**
 * Resultado da escada pura, sem I/O: ou um payload utilizável, ou o motivo da
 * rejeição. O reparo do degrau 3 é orquestrado pelo cliente (é uma segunda
 * chamada), então aqui ele aparece como `invalid_ids`.
 */
export type ExplainVerdict =
  | {
      readonly ok: true;
      readonly items: ExplainedItem[];
      readonly recommendation: ExplainedRecommendation;
      /** `repaired` quando algum texto foi descartado, removido ou truncado. */
      readonly status: 'ok' | 'repaired';
    }
  | { readonly ok: false; readonly reason: 'invalid_json' | 'invalid_ids' };

/** Resultado de um passo **não tentado**: `explain_status: null` (ausência, não falha). */
export function skippedExplain(
  reason: Extract<ExplainReason, 'budget' | 'no_candidates' | 'disabled'>,
): ExplainResult {
  return { items: [], recommendation: null, status: null, reason, model: null, tokens: null };
}

/** Milissegundos que ainda restam do orçamento total; nunca negativo. */
export function remainingBudgetMs(deadlineAtMs: number, nowMs: number): number {
  return Math.max(0, deadlineAtMs - nowMs);
}

/** Teto de uma chamada do passo de intenção: `min(INTENT_STEP_MAX_MS, restante)`. */
export function intentStepTimeoutMs(remainingMs: number): number {
  return Math.max(1, Math.min(INTENT_STEP_MAX_MS, remainingMs));
}

/** Teto de uma chamada do passo de explicação: `min(EXPLAIN_STEP_MAX_MS, restante)`. */
export function explainStepTimeoutMs(remainingMs: number): number {
  return Math.max(1, Math.min(EXPLAIN_STEP_MAX_MS, remainingMs));
}

/** `{{skill:<skill_id>}}` — o único formato de placeholder que o backend resolve. */
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

const SKILL_PLACEHOLDER_PREFIX = 'skill:';

/**
 * Marcadores que substituem temporariamente um placeholder válido durante a
 * limpeza. São caracteres da Área de Uso Privado (U+E000/U+E001): fora de
 * `\p{Cc}`, então não colidem com o texto nem disparam `no-control-regex`.
 */
const PLACEHOLDER_MARK = '\uE000';
const PLACEHOLDER_MARK_END = '\uE001';
const PLACEHOLDER_MARK_RESTORE = /\uE000(\d+)\uE001/gu;

/** Espaços duplicados e pontuação órfã que a remoção do placeholder pode deixar. */
function collapseSpaces(value: string): string {
  return value
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

/**
 * Remove todo `{{...}}` que **não** seja `{{skill:<id conhecido>}}` (degrau 5).
 *
 * O id do conjunto fica no texto: quem substitui pelo nome vindo do banco é o
 * `resolvePlaceholders` de `src/search/explanation.ts` (#42), e a interface nunca
 * recebe o placeholder cru. Placeholder desconhecido, mal formado ou `{`/`}`
 * solto é removido — citar uma skill fora do conjunto é exatamente o que a regra 1
 * proíbe a LLM de fazer.
 *
 * Os placeholders válidos são trocados por um marcador antes da limpeza: sem isso,
 * remover `}}` solto apagaria o fechamento de um placeholder legítimo.
 */
function sanitizePlaceholders(
  text: string,
  known: ReadonlySet<string>,
): { text: string; repaired: boolean } {
  let repaired = false;
  const kept: string[] = [];

  const marked = text.replace(PLACEHOLDER, (match: string, body: string) => {
    const inner = body.trim();
    if (inner.toLowerCase().startsWith(SKILL_PLACEHOLDER_PREFIX)) {
      const id = inner.slice(SKILL_PLACEHOLDER_PREFIX.length).trim();
      if (known.has(id)) {
        kept.push(match);
        return `${PLACEHOLDER_MARK}${String(kept.length - 1)}${PLACEHOLDER_MARK_END}`;
      }
    }
    repaired = true;
    return '';
  });

  // Depois da primeira passada não existe mais `{{` legítimo sem marcador: o que
  // sobrou de `{`/`}` é lixo do modelo e sairia verbatim na interface.
  const stripped = marked.replace(/[{}]+/gu, () => {
    repaired = true;
    return '';
  });

  const restored = stripped.replace(
    PLACEHOLDER_MARK_RESTORE,
    (_match: string, index: string) => kept[Number(index)] ?? '',
  );

  return { text: collapseSpaces(restored), repaired };
}

/**
 * Corta no teto do contrato **sem partir** um placeholder (degrau 4): um corte
 * seco em `{{skill:sk_…` deixaria um fragmento que nenhum resolvedor lê e que a
 * interface mostraria como texto.
 *
 * Placeholder que cabe inteiro dentro do corte fica; o que ficaria partido é
 * descartado (e o texto termina antes dele).
 */
function truncateKeepingPlaceholders(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  let cut = value.slice(0, maxChars);
  for (;;) {
    const open = cut.lastIndexOf('{{');
    if (open === -1) {
      return cut;
    }
    const close = cut.indexOf('}}', open);
    if (close !== -1) {
      // O último `{{` do corte fecha dentro dele: não há placeholder partido.
      return cut;
    }
    cut = cut.slice(0, open).trimEnd();
  }
}

/** Degraus 4 e 5 num só passo: remove placeholder inválido e depois trunca. */
function finalizeText(
  raw: string,
  known: ReadonlySet<string>,
  maxChars: number,
): { text: string; repaired: boolean } {
  const cleaned = sanitizePlaceholders(raw, known);
  const text = truncateKeepingPlaceholders(cleaned.text, maxChars).trim();
  return { text, repaired: cleaned.repaired || cleaned.text.length > maxChars };
}

/** Remove a cerca ```` ```json ```` que alguns provedores põem em volta do objeto. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/u.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Schema **estrutural** do payload (§6.5): chave fora do schema derruba o passo,
 * porque um payload que tenta `score`/`rank` é sinal de que o modelo não seguiu o
 * contrato — o campo extra não é descartado em silêncio.
 *
 * `skill_id` é `string` aqui de propósito. O `enum` com os ids do momento é o
 * primeiro dos quatro obstáculos do §6.5, mas ele só existe no decodificador
 * quando o provedor honra `json_schema` — e o `response_format` do projeto é
 * `json_object` (ADR-004). Fazer o enum falhar no zod transformaria "id
 * inventado" em `invalid_json`, quando a escada manda **descartar o item** e
 * seguir com os válidos: por isso a checagem de conjunto vive no laço abaixo.
 */
// `strip` (o default do zod), nunca `.strict()`: a regra 2 do AGENTS.md diz que
// "campo fora do schema é descartado", e a etapa de intenção já faz exatamente
// isso. Com `.strict()`, um `"reasoning": "..."` inventado pelo modelo derrubava o
// passo INTEIRO como `invalid_json` → template, enquanto a mesma situação na
// intenção só descarta a chave. A escada continua valendo: id fora do conjunto é
// descartado no laço abaixo, e `<1` sobrevivente vira `invalid_ids`.
const EXPLAIN_SCHEMA = z.object({
  items: z.array(
    z.object({
      skill_id: z.string(),
      why: z.string(),
      caveats: z.string().nullable().optional(),
    }),
  ),
  recommendation: z.object({ skill_id: z.string(), why: z.string() }),
});

/**
 * Aplica a escada de validação ao corpo do modelo (degraus 1 a 5).
 *
 * @param raw conteúdo de `choices[0].message.content` (cru ou cercado por cerca).
 * @param context conjunto ranqueado; `candidates[0]` é o `rank 1`.
 * @returns payload validado, ou o motivo da rejeição (`invalid_json`/`invalid_ids`).
 */
export function parseExplainPayload(raw: unknown, context: ExplainPayloadContext): ExplainVerdict {
  const [rank1] = context.candidates;
  // Sem conjunto não há o que explicar: nenhum id pode estar no conjunto.
  if (rank1 === undefined) {
    return { ok: false, reason: 'invalid_ids' };
  }

  // Degrau 1: não-JSON e chave fora do schema são o mesmo desfecho.
  let json: unknown;
  try {
    json = typeof raw === 'string' ? (JSON.parse(stripFence(raw)) as unknown) : raw;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  const validated = EXPLAIN_SCHEMA.safeParse(json);
  if (!validated.success) {
    return { ok: false, reason: 'invalid_json' };
  }
  const parsed = validated.data;

  const known = new Set(context.candidates.map((candidate) => candidate.skill_id));
  let repaired = false;
  const seen = new Set<string>();
  const items: ExplainedItem[] = [];

  for (const entry of parsed.items) {
    // Degrau 2 (pós-checagem, redundante ao enum de propósito): id fora do
    // conjunto é item descartado. Repetido também: a primeira explicação vale.
    if (!known.has(entry.skill_id) || seen.has(entry.skill_id)) {
      repaired = true;
      continue;
    }

    const why = finalizeText(entry.why, known, MAX_WHY_CHARS);
    if (why.text.length === 0) {
      // Sobrou nada depois de remover placeholders: o item não diz nada.
      repaired = true;
      continue;
    }

    let caveats: string | null = null;
    if (entry.caveats !== undefined && entry.caveats !== null) {
      const finalized = finalizeText(entry.caveats, known, MAX_CAVEATS_CHARS);
      caveats = finalized.text.length > 0 ? finalized.text : null;
      repaired = repaired || finalized.repaired;
    }

    seen.add(entry.skill_id);
    repaired = repaired || why.repaired;
    items.push({
      skill_id: entry.skill_id,
      why: why.text,
      caveats,
      // O agregado, não só `why`: se APENAS o `caveats` foi truncado ou teve
      // placeholder removido, o item tem de sair `repaired: true` para a flag
      // `explanation_repaired` (§5.3) disparar. `why.repaired` perdia esse caso
      // em silêncio (achado do parecer da #41).
      repaired,
    });
  }

  // Menos de um sobrevivente: o #42 pede o único reparo e cai no template.
  if (items.length === 0) {
    return { ok: false, reason: 'invalid_ids' };
  }

  // Degrau 3: a recomendação destaca o topo da lista, nunca outro item (US-05 AC1).
  if (parsed.recommendation.skill_id !== rank1.skill_id) {
    return { ok: false, reason: 'invalid_ids' };
  }

  const recommendation = finalizeText(parsed.recommendation.why, known, MAX_RECOMMENDATION_CHARS);
  if (recommendation.text.length === 0) {
    // Sem texto não há destaque a mostrar; o template do #42 cobre o caso.
    return { ok: false, reason: 'invalid_json' };
  }

  return {
    ok: true,
    items,
    recommendation: {
      skill_id: parsed.recommendation.skill_id,
      why: recommendation.text,
      repaired: recommendation.repaired,
    },
    status: repaired || recommendation.repaired ? 'repaired' : 'ok',
  };
}
