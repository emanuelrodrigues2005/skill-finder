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
import { MAX_KEYWORDS, MIN_CONFIDENCE, parseIntentPayload } from '@/llm/intent-schema';

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
function parse(payload: unknown): { intent: Intent; status: LlmStatus } {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return parseIntentPayload(raw, CONTEXT);
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
});
