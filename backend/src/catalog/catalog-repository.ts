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

/**
 * Outro processo já tem um run `running` — o índice parcial
 * `UNIQUE (status) WHERE status = 'running'` de `ingest_run` (§7.3) recusou o
 * `INSERT`.
 *
 * Existe para a rota de admin (#49) responder **409** em vez de 500: a trava do
 * processo (`IngestService`) cobre a concorrência dentro de uma réplica, e esta
 * é a trava entre processos (`make seed` rodando enquanto a API está no ar). Um
 * erro de driver em prosa não é classificável; este é.
 */
export class IngestRunInProgressError extends Error {
  constructor() {
    super('ingest_run already has a running row (UNIQUE (status) WHERE status = \'running\')');
    this.name = 'IngestRunInProgressError';
  }
}

/** Códigos estáveis gravados em `ingest_run.error_code`. */
export const INGEST_ERROR_CODES = {
  /** Run `running` de outra execução, mais velho que 2 h (§7.3). */
  staleRun: 'STALE_RUN',
  /** A fonte lançou antes de entregar qualquer item. */
  sourceFetchFailed: 'SOURCE_FETCH_FAILED',
  /** Nenhuma chave no ciclo — nada a girar, catálogo preservado. */
  emptyCatalog: 'EMPTY_CATALOG',
  /** O ciclo viu menos de 80% das chaves que pediu (guarda do §7.3). */
  lowCycleCoverage: 'LOW_CYCLE_COVERAGE',
  /** Menos de 50% do ciclo pedido chegou ao banco (falha parcial de escrita). */
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
  /**
   * Chaves distintas lidas da fonte (não itens de página). Medido **contra
   * `items_requested`**, nunca contra o total de ativos: 720 de 20.000 é o
   * rodízio funcionando (§7.3).
   */
  items_seen: number | null;
  /** Linhas de `skill` gravadas: chaves distintas, nunca itens da página. */
  items_upserted: number | null;
  items_deactivated: number | null;
  /**
   * Slots do ciclo: as chaves do rodízio (`selectRotationKeys`) mais as
   * inéditas que a fonte enumerou (`planCycle`). É a unidade do rodízio:
   * `items_seen` conta o que a fonte entregou, `items_requested` conta o que o
   * ciclo pediu para girar — e é contra este número que a guarda de 80% e a
   * razão de upsert são medidas.
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

/**
 * As duas bandas do rodízio, **separadas**: quem decide a prioridade entre elas
 * é `planCycle` (`ingest.ts`), não o repositório.
 *
 * A separação existe porque a cota de descoberta é reservada **entre** hot e
 * cold (F1 do parecer da #46): com as bandas fundidas numa lista só, a ingestão
 * não teria como saber onde o hot termina — e as inéditas que a fonte enumera
 * ficariam para trás sempre que o rodízio ocupasse o ciclo, que é o caso de todo
 * banco com mais de 720 linhas.
 */
export interface RotationBands {
  /** Hot set, já ordenado (requisição mais recente primeiro) e cortado em `hotSlots`. */
  readonly hot: readonly string[];
  /**
   * Cold set, já ordenado (vencidas primeiro, depois as mais antigas) e cortado
   * no que ainda cabe no ciclo depois do hot. **Não** inclui chave do hot.
   */
  readonly cold: readonly string[];
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

  /**
   * Skills com `is_active = true`: **gatilho** do bootstrap (catálogo vazio ×
   * seletor quebrado) e diagnóstico. Não é mais a base da guarda de 80% — ela
   * mede `items_seen` contra `items_requested`, não contra o catálogo inteiro
   * (720 de 20.000 é rodízio, não falha; §7.3).
   */
  countActiveSkills(): Promise<number>;

  /**
   * As chaves do ciclo de rodízio, **por banda**: hot set primeiro (últimos 7
   * dias de `search_request.result_ids`, até `hotSlots`), cold set depois (o
   * resto das ativas, vencidas primeiro e das mais antigas para as mais novas).
   *
   * Devolve `source_key` distintas, sem repetir chave entre hot e cold. Cada
   * banda vem cortada no seu orçamento (hot em `hotSlots`, cold no que sobra do
   * ciclo); a prioridade final é de `planCycle`. Determinística para o mesmo
   * `now` e o mesmo banco.
   */
  selectRotationKeys(params: RotationParams): Promise<RotationBands>;

  /**
   * Das chaves que a **fonte** enumera, as que o catálogo não tem como linha
   * **ativa** — as **inéditas** do ciclo (F1 do parecer da #46).
   *
   * É o complemento exato de `selectRotationKeys` no conjunto de chaves da
   * fonte: `planCycle` reserva a cota de descoberta entre hot e cold, e sem esta
   * resposta o "que sobra" seria adivinhação — a chave que só não voltou porque
   * o cold foi cortado pareceria inédita e a descoberta giraria em falso.
   *
   * Linha **inativa** conta como inédita de propósito: ela saiu do rodízio por
   * TTL de 28 dias, e é reaparecendo na fonte que ela volta a `is_active = true`.
   */
  selectUnseenKeys(candidates: readonly string[]): Promise<string[]>;

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

  /**
   * `is_active = false` para quem não é visto desde `cutoff` — o expurgo por
   * TTL (28 dias, §7.3), **o único caminho de desativação** desde a #46. Não
   * existe "desativar o que este ciclo não viu": com 720 slots para 20.000
   * skills isso apagaria o catálogo em quatro ciclos.
   *
   * O corte vem de fora: o expurgo roda fora da ingestão/pelo relógio do run,
   * mas com uma data escolhida por quem chama (nunca `now()` no meio da
   * statement), e por isso é determinístico em teste.
   */
  deactivateSkillsStaleBefore(cutoff: Date): Promise<number>;
}

/**
 * Leitura do histórico de `ingest_run` (`GET /api/v1/admin/ingest/runs`, #49).
 *
 * Porta **separada** de `CatalogRepository` de propósito: a ingestão só escreve
 * (abre/fecha run, faz upsert, expurga) e recebe essa porta por injeção; quem
 * lista o histórico é a rota de admin, e um duplo de teste da ingestão não deve
 * ser obrigado a implementar paginação.
 *
 * `PrismaCatalogRepository` implementa as duas.
 */
export interface IngestRunLog {
  /** Runs mais recentes primeiro (`started_at DESC, id DESC`). */
  listRuns(limit: number, offset: number): Promise<IngestRunRow[]>;

  /** Total de runs, para o bloco `pagination` de §5.6. */
  countRuns(): Promise<number>;
}
