/**
 * Duplo em memória da porta `SearchStore`.
 *
 * Guarda as linhas num `Map` e cunha o `search_id` com `randomUUID()` — a mesma
 * forma da coluna `uuid`. Serve a quem precisa do histórico sem Postgres; a
 * retenção de 30 dias continua sendo regra do serviço, não do armazenamento.
 */
import { randomUUID } from 'node:crypto';

import type { SearchStore, StoredSearchInput, StoredSearchRow } from './search-store.port';
import { storedSearchJson } from './search-store.port';

export class InMemorySearchStore implements SearchStore {
  private readonly rows = new Map<string, StoredSearchRow>();

  /** Cópias defensivas: o chamador não altera uma linha já gravada. */
  save(record: StoredSearchInput): Promise<StoredSearchRow> {
    const row: StoredSearchRow = {
      ...record,
      intent: {
        ...record.intent,
        keywords: [...record.intent.keywords],
        filters: { ...record.intent.filters },
      },
      result_ids: [...record.result_ids],
      search_id: randomUUID(),
      toJSON: () => storedSearchJson(row),
    };
    this.rows.set(row.request_id, row);
    return Promise.resolve(row);
  }

  findByRequestId(requestId: string): Promise<StoredSearchRow | null> {
    return Promise.resolve(this.rows.get(requestId) ?? null);
  }
}
