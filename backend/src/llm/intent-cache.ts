/**
 * Cache do passo de intenção (§6.3).
 *
 * Repetir a mesma busca não paga outra chamada ao provedor: a segunda resposta
 * volta com `status: 'cached'`, que **não** degrada (tabela do architect). O
 * cache é em memória de propósito — `llm_cache` e as migrations ficam para a
 * fase de persistência; aqui só o contrato `IntentCache` importa, para que a
 * implementação durável entre depois sem tocar no cliente.
 *
 * O relógio é injetado: TTL de 24 h não pode depender de `Date.now` no teste.
 */
import { createHash } from 'node:crypto';

import type { IntentParserResult } from './intent-parser';

/** TTL de uma entrada de intenção: 24 h. */
export const INTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Teto de entradas: o processo não cresce sem limite com query de usuário. */
export const INTENT_CACHE_MAX_ENTRIES = 512;

/** Contrato mínimo do cache; a implementação durável entra por aqui. */
export interface IntentCache<T = IntentParserResult> {
  get(key: string): T | null;
  set(key: string, value: T): void;
}

/** Partes da chave de cache (§6.3). */
export interface IntentCacheKeyParts {
  /** Etapa que respondeu; separa caches de etapas diferentes. */
  readonly kind: string;
  readonly promptVersion: string;
  readonly model: string;
  /** Texto normalizado (trim, espaços colapsados, minúsculas). */
  readonly query: string;
  /** Categorias do catálogo em ordem canônica. */
  readonly categories: readonly string[];
  /**
   * Ids **na ordem** (não canônica): só a explicação usa, porque a posição faz
   * parte da resposta — `recommendation` aponta para o `rank 1`. Ordenar aqui
   * faria duas ordens distintas compartilharem prosa (parecer da #41).
   */
  readonly candidates?: readonly string[];
  /**
   * Snapshot do catálogo. A explicação cita números (estrelas, instalações) que
   * mudam entre ciclos de ingestão; sem ele na chave, o cache serve prosa com
   * números vencidos (§4.1).
   */
  readonly catalogSnapshot?: string;
}

/** sha256 hex — usado na chave do cache e no mapa do provedor falso. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Chave estável de uma intenção.
 *
 * `sha256(kind|prompt_version|model|intent_normalizado|sorted(candidate_ids)|catalog_snapshot)`.
 * No passo de intenção ainda não existe conjunto de candidatos (ele vem depois),
 * então o slot `candidate_ids` recebe as **categorias** aceitas — o único
 * conjunto que restringe a resposta — e não há snapshot: o slot fica `-`.
 */
export function intentCacheKey(parts: IntentCacheKeyParts): string {
  const normalizedQuery = parts.query.trim().replace(/\s+/g, ' ').toLowerCase();
  const categories = parts.categories
    .map((category) => category.trim().toLowerCase())
    .sort()
    .join(',');
  // A ordem dos candidatos entra SEM `.sort()`: para a explicação ela é parte da
  // resposta (a recomendação é o `rank 1`), e ordenar aqui faria duas ordens
  // distintas acertarem a mesma prosa. Para a intenção o campo fica ausente.
  const candidates = (parts.candidates ?? []).map((candidate) => candidate.trim()).join(',');
  const snapshot = parts.catalogSnapshot === undefined ? '-' : parts.catalogSnapshot;
  return sha256Hex(
    [
      parts.kind,
      parts.promptVersion,
      parts.model,
      normalizedQuery,
      categories,
      snapshot,
      candidates,
    ].join('|'),
  );
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/**
 * Cache em memória com TTL e teto de entradas.
 *
 * Genérico no valor (`IntentParserResult` por default) porque o passo de
 * explicação (#41) usa a mesma política com o payload dele: uma cópia da classe
 * para cada etapa divergiria no primeiro ajuste de TTL.
 *
 * A ordem de inserção do `Map` dá o FIFO: quando o teto é atingido, a entrada
 * mais antiga sai — inclusive a que acabou de ser renovada, que volta para o
 * fim da fila. Não há relógio de fundo: a expiração é verificada na leitura.
 */
export class InMemoryIntentCache<T = IntentParserResult> implements IntentCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? INTENT_CACHE_TTL_MS;
    this.maxEntries = options.maxEntries ?? INTENT_CACHE_MAX_ENTRIES;
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  /** Quantas entradas vivas (expiradas ainda contam até serem lidas). */
  get size(): number {
    return this.entries.size;
  }
}
