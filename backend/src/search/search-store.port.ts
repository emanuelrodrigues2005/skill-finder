/**
 * Porta de persistência do histórico de busca (`search_request`, §4.1).
 *
 * A linha guardada é o que dá permalink à busca (`GET /api/v1/searches/{request_id}`)
 * e o que o *audit* de privacidade inspeciona: por isso **não** há IP em claro
 * aqui, só `client_hash`. O texto da consulta é guardado sempre — é ele que a
 * resposta devolve em `query`, inclusive num link compartilhado.
 *
 * `result_ids` fala `bigint`: é `BIGINT[]` na coluna. A conversão para `sk_...`
 * acontece na resposta, não no banco (decisão D-B).
 */
import type { Intent, LlmStatus } from '../contract/dto/search-response.dto';

/** Desfecho da busca gravado em `search_request.status`. */
export type StoredSearchStatus = 'ok' | 'empty' | 'degraded' | 'error';

/** O que a busca grava; `search_id` nasce no banco. */
export interface StoredSearchFields {
  /** `req_...` cunhado pelo servidor (C4) — nunca o header recebido. */
  request_id: string;
  created_at: Date;
  /** sha256(sal + IP); sem o sal não há como reverter o hash. */
  client_hash: string;
  /** sha256 do texto da consulta, para agrupar buscas iguais. */
  query_hash: string;
  /**
   * Texto da consulta como o cliente enviou. `null` só numa linha gravada antes
   * de o texto passar a ser guardado — nunca string vazia.
   */
  query_text: string | null;
  intent: Intent;
  category_slug: string | null;
  /** Ids do banco, na ordem do ranking. */
  result_ids: bigint[];
  candidates_count: number;
  llm_status: LlmStatus;
  degraded: boolean;
  latency_ms: number;
  status: StoredSearchStatus;
}

/**
 * Linha pronta para gravar.
 *
 * `toJSON` é parte da porta, e não um detalhe de log: `result_ids` é `BIGINT[]`
 * no banco, e `JSON.stringify` de um `bigint` **lança** (`Do not know how to
 * serialize a BigInt`). A linha é auditada e logada (é o que prova que o IP não
 * está nela), então ela precisa carregar a própria projeção JSON — com os ids em
 * string decimal — em vez de explodir no primeiro `JSON.stringify`.
 */
export interface StoredSearchInput extends StoredSearchFields {
  toJSON(): unknown;
}

/** Linha completa, como o permalink a lê. */
export interface StoredSearchRow extends StoredSearchInput {
  search_id: string;
}

/**
 * Projeção JSON-safe da linha, para log e auditoria.
 *
 * Lista os campos um a um de propósito: é esta lista que prova que o IP não está
 * no histórico (só o hash com sal), e um `...record` copiaria o próprio `toJSON`
 * de volta — `JSON.stringify` chamaria a projeção de novo, para sempre.
 * `query_text` fica **fora** mesmo estando gravado: §8.5 proíbe o texto da
 * consulta em log, e esta projeção existe exatamente para log e auditoria.
 * `result_ids` sai como string decimal porque `JSON.stringify` de `bigint` lança.
 */
export function storedSearchJson(
  record: StoredSearchFields & { readonly search_id?: string },
): Record<string, unknown> {
  return {
    ...(record.search_id === undefined ? {} : { search_id: record.search_id }),
    request_id: record.request_id,
    created_at: record.created_at,
    client_hash: record.client_hash,
    query_hash: record.query_hash,
    intent: record.intent,
    category_slug: record.category_slug,
    result_ids: record.result_ids.map((id) => id.toString()),
    candidates_count: record.candidates_count,
    llm_status: record.llm_status,
    degraded: record.degraded,
    latency_ms: record.latency_ms,
    status: record.status,
  };
}

export interface SearchStore {
  /** Grava a busca e devolve a linha com o id do banco. */
  save(record: StoredSearchInput): Promise<StoredSearchRow>;

  /** Busca pelo `request_id` cunhado pelo servidor; `null` quando não existe. */
  findByRequestId(requestId: string): Promise<StoredSearchRow | null>;
}
