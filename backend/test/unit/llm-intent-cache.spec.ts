/**
 * Issue #12 — os ramos que faltavam do cache de intenção
 * (`backend/src/llm/intent-cache.ts`, 76,7% de branches).
 *
 * `llm-cache.spec.ts` prova o cache **pelo cliente HTTP** (a segunda chamada não
 * toca a rede). O que ficava sem teste era a peça de baixo — a chave canônica e
 * a política de expiração/despejo — e é justamente ali que um erro é silencioso:
 *
 * - TTL: uma entrada expirada **não pode** ser servida (o provedor mudaria de
 *   resposta e ninguém veria), e `expiresAt <= now` é o limite fechado;
 * - teto: sem FIFO o processo cresce com consulta de usuário. O `Map` do JS
 *   guarda a ordem de inserção, e `set` de uma chave existente a devolve para o
 *   fim — é esse detalhe que decide **quem** sai quando o teto estoura;
 * - chave: `sha256(kind|prompt_version|model|intent_normalizado|categorias|-)`.
 *   Modelo diferente, versão de prompt diferente ou categorias em outra ordem
 *   têm de dar chaves diferentes (ou iguais, no caso da ordem).
 *
 * O relógio é injetado: um TTL de 24 h não pode depender de `Date.now`.
 */
import { createHash } from 'node:crypto';

import type { Intent } from '@/contract/dto/search-response.dto';
import type { IntentParserResult } from '@/llm/intent-parser';
import {
  INTENT_CACHE_MAX_ENTRIES,
  INTENT_CACHE_TTL_MS,
  InMemoryIntentCache,
  intentCacheKey,
  sha256Hex,
  type IntentCacheKeyParts,
} from '@/llm/intent-cache';

const INTENT: Intent = {
  category: 'backend',
  keywords: ['python', 'security'],
  filters: { exclude_with_vulnerabilities: false },
  language: 'en',
  confidence: 0.9,
};

/** Resultado do passo de intenção; o cache guarda e devolve o mesmo objeto. */
function parsed(overrides: Partial<IntentParserResult> = {}): IntentParserResult {
  return { intent: INTENT, status: 'ok', model: 'deepseek-v4.1-flash', tokens: null, ...overrides };
}

function parts(overrides: Partial<IntentCacheKeyParts> = {}): IntentCacheKeyParts {
  return {
    kind: 'intent',
    promptVersion: 'v1',
    model: 'deepseek-v4.1-flash',
    query: 'review python pull requests for security',
    categories: ['security', 'backend'],
    ...overrides,
  };
}

/** Relógio de teste: o `now` do cache é uma função, então o tempo é um número. */
function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('sha256Hex', () => {
  it('is the sha256 hex digest, deterministic', () => {
    // Fonte independente: o próprio `node:crypto`, não a implementação em teste.
    const expected = createHash('sha256').update('abc', 'utf8').digest('hex');

    expect(sha256Hex('abc')).toBe(expected);
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('intentCacheKey — forma documentada da chave (§6.3)', () => {
  it('is sha256 of kind|prompt_version|model|query|categories|-', () => {
    const expected = createHash('sha256')
      .update(
        ['intent', 'v1', 'deepseek-v4.1-flash', 'review python pull requests for security', 'backend,security', '-'].join(
          '|',
        ),
        'utf8',
      )
      .digest('hex');

    expect(intentCacheKey(parts())).toBe(expected);
  });

  it('normalizes the query: trim, collapsed spaces, lower case', () => {
    const canonical = intentCacheKey(parts({ query: 'review python pull requests for security' }));

    expect(intentCacheKey(parts({ query: '  Review   PYTHON pull requests for security  ' }))).toBe(
      canonical,
    );
  });

  it('treats the category list as a set in canonical order', () => {
    const canonical = intentCacheKey(parts({ categories: ['backend', 'security'] }));

    expect(intentCacheKey(parts({ categories: ['security', 'backend'] }))).toBe(canonical);
    expect(intentCacheKey(parts({ categories: [' Security', 'BACKEND '] }))).toBe(canonical);
  });

  it('separates a different model, a different prompt version and another kind', () => {
    const canonical = intentCacheKey(parts());

    expect(intentCacheKey(parts({ model: 'outro-modelo' }))).not.toBe(canonical);
    expect(intentCacheKey(parts({ promptVersion: 'v2' }))).not.toBe(canonical);
    expect(intentCacheKey(parts({ kind: 'explanation' }))).not.toBe(canonical);
  });

  it('separates a different query and a different category set', () => {
    const canonical = intentCacheKey(parts());

    expect(intentCacheKey(parts({ query: 'terraform plan for an aws account' }))).not.toBe(canonical);
    expect(intentCacheKey(parts({ categories: ['backend'] }))).not.toBe(canonical);
    expect(intentCacheKey(parts({ categories: [] }))).not.toBe(canonical);
  });
});

describe('InMemoryIntentCache — leitura e escrita', () => {
  it('answers null for a key that was never stored', () => {
    expect(new InMemoryIntentCache().get('ausente')).toBeNull();
  });

  it('returns exactly what was stored', () => {
    const cache = new InMemoryIntentCache();
    const value = parsed();

    cache.set('k', value);

    expect(cache.get('k')).toBe(value);
    expect(cache.size).toBe(1);
  });

  it('names the documented ceilings', () => {
    expect(INTENT_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(INTENT_CACHE_MAX_ENTRIES).toBe(512);
  });
});

describe('InMemoryIntentCache — TTL', () => {
  it('serves an entry until the TTL and drops it at the boundary', () => {
    const time = clock();
    const cache = new InMemoryIntentCache({ now: time.now, ttlMs: 1000 });
    cache.set('k', parsed());

    time.advance(999);
    expect(cache.get('k')).not.toBeNull();

    // `expiresAt <= now` é o limite: em `now === expiresAt` a entrada já não vale.
    time.advance(1);
    expect(cache.get('k')).toBeNull();
    // A leitura de uma entrada expirada também a remove do mapa.
    expect(cache.size).toBe(0);
  });

  it('accepts a fresh set after the previous one expired', () => {
    const time = clock();
    const cache = new InMemoryIntentCache({ now: time.now, ttlMs: 1000 });
    cache.set('k', parsed({ status: 'ok' }));
    time.advance(1000);
    expect(cache.get('k')).toBeNull();

    const second = parsed({ status: 'repaired' });
    cache.set('k', second);
    expect(cache.get('k')).toBe(second);

    // O novo TTL conta do segundo `set`, não do primeiro.
    time.advance(999);
    expect(cache.get('k')).not.toBeNull();
  });
});

describe('InMemoryIntentCache — teto de entradas (FIFO)', () => {
  it('evicts the oldest entry when the ceiling is exceeded', () => {
    const cache = new InMemoryIntentCache({ now: () => 0, maxEntries: 2 });

    cache.set('a', parsed());
    cache.set('b', parsed());
    cache.set('c', parsed());

    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
  });

  it('re-setting an existing key renews it: the next oldest is the one evicted', () => {
    const cache = new InMemoryIntentCache({ now: () => 0, maxEntries: 2 });
    cache.set('a', parsed());
    cache.set('b', parsed());

    // Renovar `a` a devolve para o fim da fila de inserção do `Map`.
    cache.set('a', parsed({ status: 'cached' }));
    cache.set('c', parsed());

    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).not.toBeNull();
    expect(cache.size).toBe(2);
  });

  it('a ceiling of zero stores nothing', () => {
    const cache = new InMemoryIntentCache({ now: () => 0, maxEntries: 0 });

    cache.set('a', parsed());

    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('defaults to 512 entries and to the real clock', () => {
    const cache = new InMemoryIntentCache();

    for (let index = 0; index < INTENT_CACHE_MAX_ENTRIES + 1; index += 1) {
      cache.set(`k${String(index)}`, parsed());
    }

    expect(cache.size).toBe(INTENT_CACHE_MAX_ENTRIES);
    expect(cache.get('k0')).toBeNull();
    expect(cache.get(`k${String(INTENT_CACHE_MAX_ENTRIES)}`)).not.toBeNull();
  });
});
