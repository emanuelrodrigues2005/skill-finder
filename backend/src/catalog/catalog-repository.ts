/**
 * Porta de persistência da ingestão (`docs/app/02-arquitetura.md` §7.3).
 *
 * A ingestão não conhece SQL nem Prisma: ela decide o destino do `IngestRun` e
 * chama estas operações. A implementação é
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
  /** Chaves distintas lidas da fonte (não itens de página). */
  items_seen: number | null;
  /** Linhas de `skill` gravadas: chaves distintas, nunca itens da página. */
  items_upserted: number | null;
  items_deactivated: number | null;
  /**
   * Slots que o ciclo de rodízio pediu (`selectRotationKeys`). É a unidade do
   * rodízio: `items_seen` conta o que a fonte entregou, `items_requested` conta
   * o que o ciclo pediu para girar — os dois números só são comparáveis quando
   * uma página devolve exatamente as chaves pedidas.
   */
  items_requested: number | null;
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

/**
 * Parâmetros do ciclo de rodízio (dados ratificados em F2.10 / D3): catálogo de
 * 20.000, ciclo de 6 h, 720 skills por ciclo, hot set de até 360 slots.
 *
 * `now` entra **por parâmetro**: a seleção não lê o relógio, e o mesmo instante
 * produz a mesma lista — é o que permite provar a ordem em teste.
 */
export interface RotationParams {
  /** Instante do ciclo; toda janela é calculada a partir dele. */
  readonly now: Date;
  /** Teto de chaves vindas do hot set (`search_request.result_ids` dos 7 dias). */
  readonly hotSlots: number;
  /**
   * Idade mínima, em dias, para uma skill contar como fria: o que foi visto
   * dentro dessa janela ainda está fresco e não precisa girar.
   */
  readonly coldMinDays: number;
  /** TTL da linha, em dias: passou disso, a skill é vencida e gira primeiro. */
  readonly coldMaxDays: number;
  /** Chaves por ciclo — o teto duro da resposta. */
  readonly cycleSlots: number;
}

/** Linha candidata ao rodízio, já sem id: o rodízio fala `source_key`. */
export interface RotationCandidate {
  readonly sourceKey: string;
  /** `max(search_request.created_at)` que devolveu a skill; `null` no cold set. */
  readonly requestedAt: Date | null;
  /** `skill.last_seen_at` — o que ordena o cold set. */
  readonly lastSeenAt: Date;
}

/** Porta de persistência: o que a ingestão precisa do banco, e nada mais. */
export interface CatalogRepository {
  /**
   * Fecha como `failed` / `STALE_RUN` todo run `running` que começou antes de
   * `startedBefore` — o run órfão de um processo morto no meio (§7.3).
   */
  failStaleRuns(startedBefore: Date): Promise<number>;

  /**
   * Abre um run `running` e devolve o id dele. `items_requested` é o tamanho do
   * ciclo de rodízio (quantas chaves foram pedidas), conhecido já no início.
   */
  startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number>;

  /** Fecha o run com status, contadores e erro. */
  finishRun(id: number, patch: IngestRunFinish): Promise<void>;

  /** Skills com `is_active = true` — base da guarda de 80% antes do upsert. */
  countActiveSkills(): Promise<number>;

  /**
   * As chaves do ciclo de rodízio: hot set primeiro (últimos 7 dias de
   * `search_request.result_ids`, até `hotSlots`), depois o cold set (o resto,
   * vencidas primeiro e das mais antigas para as mais novas).
   *
   * Devolve **no máximo `cycleSlots`** `source_key` distintas, sem repetir
   * chave entre hot e cold. Determinística para o mesmo `now` e o mesmo banco.
   */
  selectRotationKeys(params: RotationParams): Promise<string[]>;

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

  /**
   * `is_active = false` para quem não é visto desde `cutoff` — o expurgo por
   * TTL (28 dias), que roda **fora** da ingestão e por isso não empresta o
   * relógio de um run.
   *
   * É a mesma statement de `deactivateSkillsNotSeenSince`; o nome próprio é o
   * que separa as duas razões de desativar (fim de um run × TTL vencido).
   */
  deactivateSkillsStaleBefore(cutoff: Date): Promise<number>;
}
