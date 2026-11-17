/**
 * Implementação Prisma/Postgres da porta de histórico (`search_request`, §4.1).
 *
 * A tabela é a memória da busca (US-09) e o que o permalink lê. Duas decisões
 * que valem aqui:
 *
 * - o `search_id` é o `id` (uuid) gerado pelo banco — nome diferente no contrato
 *   (`search_id`) e na coluna (`id`), de propósito: um `id` solto no payload não
 *   diz de que recurso ele é;
 * - `result_ids` é `BIGINT[]`: a conversão para `sk_...` acontece na resposta
 *   (D-B), nunca no banco.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

import type { Intent, LlmStatus } from '../contract/dto/search-response.dto';

import {
  storedSearchJson,
  type SearchStore,
  type StoredSearchInput,
  type StoredSearchRow,
} from './search-store.port';

/** Colunas que a porta devolve; evita depender do tipo gerado linha a linha. */
const ROW_COLUMNS = {
  id: true,
  requestId: true,
  createdAt: true,
  clientHash: true,
  queryHash: true,
  queryText: true,
  intent: true,
  categorySlug: true,
  resultIds: true,
  candidatesCount: true,
  llmStatus: true,
  degraded: true,
  latencyMs: true,
  status: true,
} as const;

export class PrismaSearchStoreRepository implements SearchStore {
  constructor(private readonly prisma: PrismaClient) {}

  async save(record: StoredSearchInput): Promise<StoredSearchRow> {
    const row = await this.prisma.searchRequest.create({
      data: {
        requestId: record.request_id,
        createdAt: record.created_at,
        clientHash: record.client_hash,
        queryHash: record.query_hash,
        queryText: record.query_text,
        // `Intent` já foi validada contra o schema (§6.3); o cast é só a ponte
        // para o tipo `Json` do Prisma.
        intent: record.intent as unknown as Prisma.InputJsonValue,
        categorySlug: record.category_slug,
        resultIds: record.result_ids,
        candidatesCount: record.candidates_count,
        llmStatus: record.llm_status,
        degraded: record.degraded,
        latencyMs: record.latency_ms,
        status: record.status,
      },
      select: ROW_COLUMNS,
    });

    return toStoredRow(row);
  }

  async findByRequestId(requestId: string): Promise<StoredSearchRow | null> {
    const row = await this.prisma.searchRequest.findUnique({
      where: { requestId },
      select: ROW_COLUMNS,
    });
    return row === null ? null : toStoredRow(row);
  }
}

interface SearchRequestRow {
  id: string;
  requestId: string;
  createdAt: Date;
  clientHash: string;
  queryHash: string;
  queryText: string | null;
  intent: Prisma.JsonValue | null;
  categorySlug: string | null;
  resultIds: bigint[];
  candidatesCount: number | null;
  llmStatus: string | null;
  degraded: boolean;
  latencyMs: number | null;
  status: string;
}

function toStoredRow(row: SearchRequestRow): StoredSearchRow {
  if (row.intent === null) {
    // A busca sempre grava a intenção; uma linha sem ela foi escrita por fora da
    // API. Falhar alto é melhor que devolver um permalink com intenção vazia.
    throw new Error(`search_request ${row.requestId} has no stored intent`);
  }
  const stored: StoredSearchRow = {
    search_id: row.id,
    request_id: row.requestId,
    created_at: row.createdAt,
    client_hash: row.clientHash,
    query_hash: row.queryHash,
    query_text: row.queryText,
    intent: row.intent as unknown as Intent,
    category_slug: row.categorySlug,
    result_ids: row.resultIds,
    candidates_count: row.candidatesCount ?? 0,
    llm_status: (row.llmStatus ?? 'unavailable') as LlmStatus,
    degraded: row.degraded,
    latency_ms: row.latencyMs ?? 0,
    status: row.status as StoredSearchRow['status'],
    toJSON: () => storedSearchJson(stored),
  };
  return stored;
}
