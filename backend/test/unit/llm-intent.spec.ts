/**
 * Issue #9 (F2.5) — schema e coercoes da `Intent` (docs/app/02-arquitetura.md §6.3).
 *
 * Contrato exigido do codigo de producao (`backend/src/llm/intent-schema.ts`):
 *
 *   export const MAX_KEYWORDS: number;                 // 8
 *   export const MIN_CONFIDENCE: number;               // 0.35
 *   export function parseIntentPayload(
 *     raw: unknown,                                    // JSON do modelo, cru ou cercado por ```json
 *     context: { query: string; categories: readonly string[] },
 *   ): { intent: Intent; status: LlmStatus };
 *
 * Regras ratificadas pelo architect:
 *   - campo fora do schema e descartado e NAO muda o status (segue `ok`);
 *   - `category` fora do catalogo -> `null` + `repaired`;
 *   - `keywords` > 8 -> trunca em 8 + `repaired`;
 *   - `keywords` vazio -> reconstroi da query + `repaired`;
 *   - `confidence < 0.35` -> `low_confidence` (0.35 exato NAO e baixa);
 *   - corpo nao-JSON / JSON fora do schema -> `unavailable` (coberto no spec do cliente).
 * A `Intent` nunca carrega `score` nem pesos de ranking: o ranking e deterministico (regra 1).
 */
import type { Intent, LlmStatus } from '@/contract/dto/search-response.dto';
import {
  IntentPayloadError,
  MAX_FIELD_CHARS,
  MAX_KEYWORDS,
  MIN_CONFIDENCE,
  parseIntentPayload,
} from '@/llm/intent-schema';

const CONTEXT = {
  query: 'review python pull requests for security issues',
  categories: ['security', 'dev', 'data', 'testing', 'ops', 'docs'],
} as const;

/** Resposta valida do modelo, antes de qualquer coercoo. */
const VALID = {
  category: 'security',
  keywords: ['pull request', 'security', 'python'],
  filters: { exclude_with_vulnerabilities: true },
  language: 'en',
  confidence: 0.82,
};

/** O parser recebe o texto de `choices[0].message.content`, nao o objeto ja parseado. */
function parse(payload: unknown): { intent: Intent; status: LlmStatus; keywordsEn: readonly string[] } {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return parseIntentPayload(raw, CONTEXT);
}

/**
 * `parseIntentPayload` nao devolve `unavailable`: ele **lanca**. Quem traduz o
 * erro em `unavailable` e o cliente (`openai-compat.ts`), coberto no spec dele;
 * aqui interessa que o corpo fora do schema seja recusado, com o status que a
 * porta publica carrega.
 */
function payloadError(run: () => unknown): IntentPayloadError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(IntentPayloadError);
  return thrown as IntentPayloadError;
}

describe('intent schema (docs/app/02-arquitetura.md 6.3)', () => {
  it('drops fields outside the Intent schema', () => {
    const { intent, status } = parse({
      ...VALID,
      score: 0.9,
      weights: { stars: 0.5, vulns: 0.3, installs: 0.2 },
      breakdown: { S: 0.71, P: 1, I: 0.74 },
    });

    expect(status).toBe('ok');
    expect(Object.keys(intent).sort()).toEqual([
      'category',
      'confidence',
      'filters',
      'keywords',
      'language',
    ]);
    expect(intent).not.toHaveProperty('score');
    expect(intent).not.toHaveProperty('weights');
    expect(intent).not.toHaveProperty('breakdown');
    expect(intent.filters).toEqual({ exclude_with_vulnerabilities: true });
  });

  it('never carries ranking weights or a score', () => {
    const { intent } = parse({
      ...VALID,
      score: 0.42,
      weights: { stars: 0.5, vulns: 0.3, installs: 0.2 },
    });

    expect(JSON.stringify(intent)).not.toMatch(/score|weight/i);
  });

  it('coerces an unknown category to null', () => {
    const { intent, status } = parse({ ...VALID, category: 'not-a-real-category' });

    expect(intent.category).toBeNull();
    expect(status).toBe('repaired');
  });

  it('keeps a category that exists in the catalog', () => {
    const { intent, status } = parse({ ...VALID, category: 'data' });

    expect(intent.category).toBe('data');
    expect(status).toBe('ok');
  });

  it('truncates keywords to eight', () => {
    const keywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const { intent, status } = parse({ ...VALID, keywords });

    expect(status).toBe('repaired');
    expect(intent.keywords).toHaveLength(MAX_KEYWORDS);
    expect(intent.keywords).toEqual(keywords.slice(0, 8));
  });

  it('rebuilds empty keywords from the query', () => {
    const { intent, status } = parse({ ...VALID, keywords: [] });

    expect(status).toBe('repaired');
    expect(intent.keywords.length).toBeGreaterThan(0);
    expect(intent.keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    // Toda keyword reconstruida vem do proprio texto da query.
    for (const keyword of intent.keywords) {
      expect(CONTEXT.query.toLowerCase()).toContain(keyword.toLowerCase());
    }
  });

  it('flags low confidence below 0.35', () => {
    const low = parse({ ...VALID, confidence: 0.2 });
    expect(low.status).toBe('low_confidence');
    expect(low.intent.confidence).toBe(0.2);
  });

  it('accepts 0.35 as the confidence boundary', () => {
    const { status } = parse({ ...VALID, confidence: MIN_CONFIDENCE });

    expect(MIN_CONFIDENCE).toBe(0.35);
    expect(status).toBe('ok');
  });

  it('accepts a fenced json block', () => {
    const fenced = ['```json', JSON.stringify(VALID), '```'].join('\n');
    const { intent, status } = parse(fenced);

    expect(status).toBe('ok');
    expect(intent.category).toBe('security');
    expect(intent.keywords).toEqual(VALID.keywords);
  });

  /**
   * F3: teto de `MAX_FIELD_CHARS` por campo. No limite o valor passa intacto; um
   * caractere acima o corpo sai do schema e derruba o passo. Sem teste, um teto
   * removido numa refatoração vira canal de texto livre vindo do modelo.
   */
  it('keeps a keyword at the field cap and rejects one character above it', () => {
    const atCap = 'k'.repeat(MAX_FIELD_CHARS);
    const accepted = parse({ ...VALID, keywords: [atCap] });

    expect(accepted.status).toBe('ok');
    expect(accepted.intent.keywords).toEqual([atCap]);

    expect(payloadError(() => parse({ ...VALID, keywords: [`${atCap}k`] })).status).toBe(
      'unavailable',
    );
  });

  it('rejects a language field above the field cap', () => {
    const tooLong = 'l'.repeat(MAX_FIELD_CHARS + 1);

    expect(payloadError(() => parse({ ...VALID, language: tooLong })).status).toBe('unavailable');
  });

  /**
   * F3: `language` e `en | pt | other` (§6.3) — caixa e espaços não importam, mas
   * nome de linguagem de programação não entra como texto livre na `Intent`
   * (regra 3: dado inválido não vira palpite).
   */
  it('coerces language to en | pt | other', () => {
    const pt = parse({ ...VALID, language: 'pt' });
    expect(pt.intent.language).toBe('pt');
    expect(pt.status).toBe('ok');

    const upper = parse({ ...VALID, language: ' EN ' });
    expect(upper.intent.language).toBe('en');
    expect(upper.status).toBe('ok');

    const unknown = parse({ ...VALID, language: 'javascript' });
    expect(unknown.intent.language).toBe('other');
    expect(unknown.status).toBe('repaired');

    // `pt-BR` e um codigo valido de verdade, mas o contrato e de duas letras.
    expect(parse({ ...VALID, language: 'pt-BR' }).intent.language).toBe('other');
  });

  /**
   * Issue #40: o `search_doc` do catalogo e indexado em ingles. A `Intent` do
   * contrato **nao** muda — `keywords_en` e interno e sai ao lado dela, no
   * resultado do passo —, e um payload sem ele continua `ok` (o recuperador cai
   * na `keywords` da consulta em vez de derrubar a busca).
   */
  describe('english keywords for the FTS (issue #40)', () => {
    it('carries keywords_en next to the intent, never inside it', () => {
      const { intent, status, keywordsEn } = parse({
        ...VALID,
        keywords_en: ['pull request', 'security'],
      });

      expect(status).toBe('ok');
      expect(keywordsEn).toEqual(['pull request', 'security']);
      // O contrato publico fica intacto: sem `keywords_en` dentro da `Intent`.
      expect(intent).not.toHaveProperty('keywords_en');
      expect(Object.keys(intent).sort()).toEqual([
        'category',
        'confidence',
        'filters',
        'keywords',
        'language',
      ]);
    });

    it('falls back to the intent keywords when keywords_en is missing or empty', () => {
      // Ausente: nao e mentira do modelo, a busca apenas usa `keywords`.
      const absent = parse({ ...VALID, keywords: ['documentar', 'api'] });
      expect(absent.status).toBe('ok');
      expect(absent.keywordsEn).toEqual(['documentar', 'api']);

      // Vazio: mesmo desfecho, mas o campo prometido veio em branco -> `repaired`.
      const empty = parse({ ...VALID, keywords: ['documentar', 'api'], keywords_en: [] });
      expect(empty.status).toBe('repaired');
      expect(empty.keywordsEn).toEqual(['documentar', 'api']);
    });

    it('truncates keywords_en to eight terms', () => {
      const keywordsEn = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      const { status, keywordsEn: parsed } = parse({ ...VALID, keywords_en: keywordsEn });

      expect(status).toBe('repaired');
      expect(parsed).toEqual(keywordsEn.slice(0, MAX_KEYWORDS));
    });

    it('drops blank terms from keywords_en instead of querying for them', () => {
      const { keywordsEn } = parse({ ...VALID, keywords_en: ['  ', 'security', ''] });

      expect(keywordsEn).toEqual(['security']);
    });
  });
});
