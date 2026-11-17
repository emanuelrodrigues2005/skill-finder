/**
 * Issue #9 (F2.5) — `FakeIntentParser`: determinismo do provedor falso que roda em dev e CI.
 *
 * Contrato exigido do codigo de producao (`backend/src/llm/fake.ts`):
 *
 *   export class FakeIntentParser implements IntentParser {
 *     constructor(cases: ReadonlyArray<{ query: string; intent: Intent }>);
 *   }
 *
 * O caso e encontrado por `sha256(query)` sobre o mapa congelado em
 * `backend/test/fixtures/intents.json` (docs/app/03-plano-app.md F2.5-t4). Query desconhecida cai
 * no fallback por palavras-chave, com `category: null` e status `repaired` (mesma semantica da
 * reconstrucao de keywords de §6.3). O falso nao fala com a rede: `model` e `tokens` sao `null`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_KEYWORDS } from '@/llm/intent-schema';
import { FakeIntentParser } from '@/llm/fake';

interface FixtureCase {
  query: string;
  intent: {
    category: string | null;
    keywords: string[];
    filters: { exclude_with_vulnerabilities: boolean };
    language: string;
    confidence: number;
  };
}

function loadCases(): FixtureCase[] {
  const raw = readFileSync(join(__dirname, 'fixtures', 'intents.json'), 'utf8');
  return JSON.parse(raw) as FixtureCase[];
}

/** Catalogo de entrada do parser: as categorias que a fixture realmente usa. */
function catalogOf(cases: FixtureCase[]): string[] {
  const categories = cases
    .map((testCase) => testCase.intent.category)
    .filter((category): category is string => category !== null);
  return [...new Set(categories)].sort();
}

describe('fake intent parser (docs/app/03-plano-app.md F2.5-t4)', () => {
  it('is deterministic for every fixture case', async () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(8);

    const parser = new FakeIntentParser(cases);
    const categories = catalogOf(cases);

    for (const testCase of cases) {
      const first = await parser.parse(testCase.query, categories);
      const second = await parser.parse(testCase.query, categories);

      expect(second).toEqual(first);
      expect(first.intent).toEqual(testCase.intent);
      expect(first.status).toBe('ok');
      // Nenhum provedor foi chamado.
      expect(first.model).toBeNull();
      expect(first.tokens).toBeNull();
    }
  });

  it('falls back to keywords for an unknown query', async () => {
    const cases = loadCases();
    const parser = new FakeIntentParser(cases);
    const query = 'orchestrate a kubernetes rollout for a helm chart';

    const result = await parser.parse(query, catalogOf(cases));

    expect(result.status).toBe('repaired');
    expect(result.intent.category).toBeNull();
    expect(result.intent.keywords.length).toBeGreaterThan(0);
    expect(result.intent.keywords.length).toBeLessThanOrEqual(MAX_KEYWORDS);
    for (const keyword of result.intent.keywords) {
      expect(query.toLowerCase()).toContain(keyword.toLowerCase());
    }
    expect(result.model).toBeNull();
    expect(result.tokens).toBeNull();
  });
});
