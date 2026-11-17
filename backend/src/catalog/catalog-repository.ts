/**
 * Porta de persistência da ingestão (`docs/app/02-arquitetura.md` §7.3).
 *
 * A ingestão não conhece SQL nem Prisma: ela decide o destino do `IngestRun` e
 * chama estas seis operações. A implementação é
 * `prisma-catalog.repository.ts` (produção); a suíte injeta um duplo em
 * memória definido no próprio spec, porque nenhum teste abre socket.
 *
 * A semântica de cada operação é a da statement ratificada — chave
 * `source_key`, desativação por `last_seen_at < seenAt` numa única passada,
 * nunca por lista de ids.
 */
import type { SkillRecord } from './skill-source';

/** Valores possíveis de `ingest_run.status` (`enum IngestStatus`). */
export type IngestRunStatus = 'running' | 'ok' | 'partial' | 'failed';

/** Códigos estáveis gravados em `ingest_run.error_code`. */
export const INGEST_ERROR_CODES = {
  /** Run `running` de outra execução, mais velho que 2 h (§7.3). */
  staleRun: 'STALE_RUN',
  /** A fonte lançou antes de entregar qualquer item. */
  sourceFetchFailed: 'SOURCE_FETCH_FAILED',
  /** A fonte respondeu, mas sem nenhum item — catálogo preservado. */
  emptyCatalog: 'EMPTY_CATALOG',
  /** Uma página falhou depois de outras terem entregado itens. */
  pageFetchFailed: 'PAGE_FETCH_FAILED',
  /** Teto de 200 páginas atingido antes de esgotar a fonte (§7.3). */
  pageLimitReached: 'PAGE_LIMIT_REACHED',
  /** Menos de 50% do que foi lido chegou ao banco (falha parcial de escrita). */
  lowUpsertRatio: 'LOW_UPSERT_RATIO',
  /** O repositório lançou (upsert/contagem); o run é fechado como `failed`. */
  repositoryFailed: 'REPOSITORY_FAILED',
} as const;

/**
 * Linha de `ingest_run` como o repositório a devolve. Mutável de propósito: o
 * duplo em memória fecha a linha (`status`, contadores) como o `UPDATE` faz.
 */
export interface IngestRunRow {
  id: number;
  adapter: string;
  started_at: Date;
  finished_at: Date | null;
  status: IngestRunStatus;
  items_seen: number | null;
  items_upserted: number | null;
  items_deactivated: number | null;
  error_code: string | null;
  error_detail: string | null;
}

/** Campos que fecham um run (`running -> ok | partial | failed`). */
export interface IngestRunFinish {
  readonly status: 'ok' | 'partial' | 'failed';
  readonly finished_at: Date;
  readonly items_seen: number;
  readonly items_upserted: number;
  readonly items_deactivated: number;
  readonly error_code?: string | null;
  readonly error_detail?: string | null;
}

/** Porta de persistência: o que a ingestão precisa do banco, e nada mais. */
export interface CatalogRepository {
  /**
   * Fecha como `failed` / `STALE_RUN` todo run `running` que começou antes de
   * `startedBefore` — o run órfão de um processo morto no meio (§7.3).
   */
  failStaleRuns(startedBefore: Date): Promise<number>;

  /** Abre um run `running` e devolve o id dele. */
  startRun(run: { adapter: string; started_at: Date }): Promise<number>;

  /** Fecha o run com status, contadores e erro. */
  finishRun(id: number, patch: IngestRunFinish): Promise<void>;

  /** Skills com `is_active = true` — base da guarda de 80% antes do upsert. */
  countActiveSkills(): Promise<number>;

  /**
   * `INSERT ... ON CONFLICT (source_key) DO UPDATE`: regrava a linha, marca
   * `is_active = true`, `last_seen_at = seenAt` e preserva o `first_seen_at`
   * mais antigo (`LEAST`). Chave repetida no lote é fundida na última
   * ocorrência — uma linha por `source_key` distinta, e é esse número que a
   * operação devolve.
   *
   * Na mesma transação, grava `skill_metric_snapshot` (`captured_at = seenAt`)
   * para as chaves do lote cuja métrica mudou desde o último snapshot
   * (§7.3, passo 4). A sobrescrita de `stars`/`installs` continua sendo o
   * sinal de falha do seletor; o histórico é o que impede a perda definitiva.
   */
  upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number>;

  /** `is_active = false` para quem não foi visto desde `seenAt`. */
  deactivateSkillsNotSeenSince(seenAt: Date): Promise<number>;
}
