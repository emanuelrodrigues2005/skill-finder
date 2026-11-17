/**
 * Provedor falso determinístico (`docs/app/03-plano-app.md` F2.5-t4).
 *
 * Roda em dev e CI **por injeção de dependência**, nunca por variável de ambiente
 * (regra 5). O caso é encontrado por `sha256(query)` sobre o mapa congelado em
 * `backend/test/fixtures/intents.json`: a mesma consulta devolve sempre a mesma
 * intenção, sem rede e sem relógio. Consulta desconhecida cai no fallback
 * lexical com `category: null` e `status: 'repaired'` — a mesma semântica da
 * reconstrução de keywords de §6.3, para o teste nunca receber lista vazia.
 *
 * `model` e `tokens` são `null`: nenhum provedor foi chamado.
 */
import type { Intent } from '@/contract/dto/search-response.dto';

import { sha256Hex } from './intent-cache';
import { lexicalIntent } from './intent-schema';
import type { IntentParser, IntentParserResult } from './intent-parser';

/** Um caso congelado: consulta conhecida -> intenção esperada. */
export interface FakeIntentCase {
  readonly query: string;
  readonly intent: Intent;
}

export class FakeIntentParser implements IntentParser {
  private readonly casesByHash: Map<string, Intent>;

  constructor(cases: ReadonlyArray<FakeIntentCase>) {
    this.casesByHash = new Map(
      cases.map((testCase) => [sha256Hex(testCase.query), cloneIntent(testCase.intent)]),
    );
  }

  parse(query: string, _categories: readonly string[]): Promise<IntentParserResult> {
    const hit = this.casesByHash.get(sha256Hex(query));
    if (hit !== undefined) {
      return Promise.resolve({ intent: cloneIntent(hit), status: 'ok', model: null, tokens: null });
    }
    return Promise.resolve({
      intent: lexicalIntent(query),
      status: 'repaired',
      model: null,
      tokens: null,
    });
  }
}

/** Cópia rasa com arrays/objetos novos: o chamador não muta a fixture. */
function cloneIntent(intent: Intent): Intent {
  return {
    category: intent.category,
    keywords: [...intent.keywords],
    filters: { exclude_with_vulnerabilities: intent.filters.exclude_with_vulnerabilities },
    language: intent.language,
    confidence: intent.confidence,
  };
}
