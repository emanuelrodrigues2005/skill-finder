/**
 * Schema e coerções da `Intent` (`docs/app/02-arquitetura.md` §6.3).
 *
 * Tudo o que o modelo devolve é dado não confiável (regra 2 do `AGENTS.md`):
 * o JSON é validado contra o schema da `Intent`, o campo fora do schema é
 * descartado e as coerções abaixo são registradas no `status` do passo:
 *
 *   - `category` fora do catálogo do momento -> `null` + `repaired`;
 *   - `keywords` > {@link MAX_KEYWORDS} -> truncadas + `repaired`;
 *   - `keywords` vazias -> reconstruídas da própria consulta + `repaired`;
 *   - `language` fora de `en`/`pt`/`other` -> `other` + `repaired`;
 *   - `confidence` < {@link MIN_CONFIDENCE} -> `low_confidence`.
 *
 * Campo **ausente** é reparado (o texto do usuário ainda rende uma intenção útil);
 * campo **com o tipo errado** ou corpo que não é JSON derruba o passo com
 * {@link IntentPayloadError} — o chamador traduz isso em `unavailable` e segue com
 * o fallback lexical (§7.4). A `Intent` nunca carrega `score` nem pesos: o
 * ranking é determinístico (regra 1).
 */
import { z } from 'zod';

import type { Intent, LlmStatus } from '@/contract/dto/search-response.dto';

/** Teto de `keywords` por intenção (§6.3). */
export const MAX_KEYWORDS = 8;

/** Abaixo disso o passo é `low_confidence`; exatamente 0.35 ainda é confiável. */
export const MIN_CONFIDENCE = 0.35;

/**
 * Teto de caracteres por campo vindo do modelo. Campo mais longo que isto não é
 * truncado: é corpo fora do schema e derruba o passo para `unavailable` — o
 * schema existe para o que o modelo prometeu não inchar o resto do caminho.
 */
export const MAX_FIELD_CHARS = 64;

/**
 * Teto do campo `language` antes da coerção: `en`, `pt` e `other` cabem com
 * folga. Acima disso o valor nem é considerado — vira `other` + `repaired` —,
 * para o campo não ser um canal de texto livre vindo do modelo.
 */
export const MAX_LANGUAGE_CHARS = 8;

/**
 * `language` do contrato (`docs/app/02-arquitetura.md` §6.3):
 * `"en" | "pt" | "other"`. `other` é o valor declarado para "não sei" — e é o
 * que a coerção usa no lugar de um palpite (regra 3: dado ausente não vira
 * invenção).
 */
export const INTENT_LANGUAGES = ['en', 'pt', 'other'] as const;

export type IntentLanguage = (typeof INTENT_LANGUAGES)[number];

const INTENT_LANGUAGE_SET: ReadonlySet<string> = new Set(INTENT_LANGUAGES);

/** Contexto necessário para validar e reparar a intenção. */
export interface IntentPayloadContext {
  /** Texto do usuário; fonte das keywords quando o modelo devolve o campo vazio. */
  readonly query: string;
  /** Slugs do catálogo do momento; qualquer outro vira `null`. */
  readonly categories: readonly string[];
}

/**
 * Corpo do modelo fora do schema (não-JSON, JSON com tipo errado).
 *
 * Não carrega mensagem do provedor de propósito: a mensagem de um 401 pode citar
 * a chave, e nada derivado dela chega ao resultado (regra 4).
 */
export class IntentPayloadError extends Error {
  readonly status: LlmStatus = 'unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'IntentPayloadError';
  }
}

/**
 * Palavras que não distinguem skills entre si. Curta de propósito: o fallback
 * lexical existe para a busca não morrer, não para competir com o modelo.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'about',
  'uma',
  'uns',
  'umas',
  'para',
  'por',
  'com',
  'que',
  'dos',
  'das',
  'como',
  'meu',
  'minha',
]);

/**
 * Keywords tiradas do próprio texto da consulta (fallback determinístico).
 *
 * Cada keyword é um pedaço literal da consulta em minúsculas, o que mantém o
 * recuperador lexical honesto: nada é inventado quando a LLM falha. A saída
 * respeita {@link MAX_KEYWORDS} e nunca é vazia para consulta não vazia.
 */
export function lexicalKeywords(query: string, limit: number = MAX_KEYWORDS): string[] {
  const words =
    query
      .normalize('NFC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const meaningful = words.filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  const chosen = meaningful.length > 0 ? meaningful : words;
  const unique = [...new Set(chosen)].slice(0, Math.max(0, limit));
  if (unique.length > 0) {
    return unique;
  }
  const whole = query.trim().toLowerCase();
  return whole.length > 0 ? [whole.slice(0, 64)] : [];
}

/** `Intent` inteiramente reconstruída do texto: sem modelo, sem categoria. */
export function lexicalIntent(query: string): Intent {
  return {
    category: null,
    keywords: lexicalKeywords(query),
    filters: { exclude_with_vulnerabilities: false },
    // `other`, não `en`: sem o modelo não há evidência do idioma (regra 3).
    language: 'other',
    confidence: 0,
  };
}

/** Schema da resposta do modelo. Campo extra é descartado (`strip`) sem mexer no status. */
const payloadSchema = z.object({
  category: z.string().max(MAX_FIELD_CHARS).nullable().optional(),
  keywords: z.array(z.string().max(MAX_FIELD_CHARS)).optional(),
  filters: z.object({ exclude_with_vulnerabilities: z.boolean().optional() }).optional(),
  language: z.string().max(MAX_FIELD_CHARS).optional(),
  confidence: z.number().optional(),
});

type IntentPayload = z.infer<typeof payloadSchema>;

/** Remove a cerca ```` ```json ```` que alguns provedores põem em volta do objeto. */
function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  const body = stripFence(raw);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new IntentPayloadError('completion content is not JSON');
  }
}

function validate(raw: unknown): IntentPayload {
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new IntentPayloadError('completion does not match the intent schema');
  }
  return parsed.data;
}

/**
 * Valida o corpo do modelo e devolve a `Intent` já coerida com o `status` do passo.
 *
 * @param raw conteúdo de `choices[0].message.content` (cru ou cercado por ```` ```json ````).
 * @throws IntentPayloadError quando o corpo não é JSON ou não bate com o schema.
 */
export function parseIntentPayload(
  raw: unknown,
  context: IntentPayloadContext,
): { intent: Intent; status: LlmStatus } {
  const payload = validate(parseJson(raw));

  let repaired = false;

  // Categoria: só vale se existir no catálogo desta busca.
  let category: string | null = null;
  if (payload.category !== undefined && payload.category !== null) {
    const slug = payload.category.trim().toLowerCase();
    const known = context.categories.find((candidate) => candidate.toLowerCase() === slug);
    if (known !== undefined) {
      category = known;
    } else {
      repaired = true;
    }
  }

  // Keywords: descarta vazias, trunca no teto e reconstrói da consulta se sobrar nada.
  let keywords = (payload.keywords ?? [])
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
  if (keywords.length !== (payload.keywords?.length ?? 0)) {
    repaired = true;
  }
  if (keywords.length > MAX_KEYWORDS) {
    keywords = keywords.slice(0, MAX_KEYWORDS);
    repaired = true;
  }
  if (keywords.length === 0) {
    keywords = lexicalKeywords(context.query);
    repaired = true;
  }

  // Confiança: fora de [0, 1] é limitada, não descartada.
  const requestedConfidence = payload.confidence;
  const confidence = Math.min(1, Math.max(0, requestedConfidence ?? 0));
  if (requestedConfidence === undefined || requestedConfidence !== confidence) {
    repaired = true;
  }

  // Idioma: o contrato é `en | pt | other` (§6.3) e o campo tem teto de
  // {@link MAX_LANGUAGE_CHARS}. Fora disso — `"fr"`, `"pt-BR"`, `"javascript"` —
  // vira `other` + `repaired`, em vez de entrar como texto livre na `Intent`
  // (regra 3: dado ausente/inválido não vira palpite).
  const rawLanguage = payload.language;
  const normalizedLanguage = rawLanguage?.trim().toLowerCase();
  const candidate =
    normalizedLanguage !== undefined && normalizedLanguage.length <= MAX_LANGUAGE_CHARS
      ? normalizedLanguage
      : undefined;
  const language: IntentLanguage =
    candidate !== undefined && INTENT_LANGUAGE_SET.has(candidate)
      ? (candidate as IntentLanguage)
      : 'other';
  if (rawLanguage === undefined || !INTENT_LANGUAGE_SET.has(candidate ?? '')) {
    repaired = true;
  }

  const exclude = payload.filters?.exclude_with_vulnerabilities;
  if (exclude === undefined) {
    repaired = true;
  }

  const status: LlmStatus =
    confidence < MIN_CONFIDENCE ? 'low_confidence' : repaired ? 'repaired' : 'ok';

  return {
    intent: {
      category,
      keywords,
      filters: { exclude_with_vulnerabilities: exclude ?? false },
      language,
      confidence,
    },
    status,
  };
}
