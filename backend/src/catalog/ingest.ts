/**
 * Orquestração do `IngestRun` por **rodízio** (`docs/app/02-arquitetura.md` §7.3,
 * decisão D3 da F2.10, issues #46 e #48).
 *
 * A ingestão não pagina mais o catálogo: a unidade de aquisição é a **chave**.
 * Cada execução
 *
 *   1. fecha run órfão (`startedAt - 2 h`) e monta o ciclo, **nesta
 *      prioridade** (F1 do parecer da #46 — a descoberta não é faminta):
 *      **hot** (`selectRotationKeys`, até `HOT_SLOTS`), **inéditas** (o que a
 *      fonte enumera e `selectUnseenKeys` confirma que o catálogo não tem como
 *      linha ativa, em ordem de `source_key`) e **cold** (o resto do rodízio),
 *      até o teto do ciclo. É a descoberta contínua: o universo é o conjunto de
 *      chaves da fonte, não o conjunto de linhas do banco;
 *   2. abre o run com `items_requested` = tamanho do ciclo;
 *   3. pede exatamente essas chaves (`fetchSkills(keys)`);
 *   4. faz upsert por `source_key` (`last_seen_at`, `is_active = true`);
 *   5. expurga por **idade** (`deactivateSkillsStaleBefore(startedAt - 28 d)`).
 *
 * Sem banco, sem docker, sem rede: recebe a fonte e o repositório por injeção.
 * O relógio também é injetado — `startedAt` é parâmetro e toda janela sai dele,
 * nunca de `new Date()` lido no meio da decisão.
 *
 * Tabela ratificada (transições `running -> ok | partial | failed`), com
 * `E = items_requested` (o tamanho do ciclo) e `S = items_seen`:
 *
 *   | condição                                          | status                     |
 *   | fonte lança antes de gravar / repositório lança    | failed                     |
 *   | `E = 0` (nenhuma chave no ciclo)                  | partial/EMPTY_CATALOG      |
 *   | `E > 0` e `S = 0` (a fonte respondeu vazio)       | partial/LOW_CYCLE_COVERAGE |
 *   | `S < 0,8 × E` (guarda de 80%)                     | partial/LOW_CYCLE_COVERAGE |
 *   | `upserted < 0,5 × E`                              | partial/LOW_UPSERT_RATIO   |
 *   | caso contrário                                    | ok                         |
 *
 * **Desativação só por idade**, e só com run que entregou algo: não existe mais
 * "desativar o que este ciclo não viu" (com 720 slots para 20.000 skills, o que
 * não foi visitado é o normal) e fonte que devolve zero não pode auto-desativar
 * o catálogo — por isso o expurgo exige `status !== 'failed'` **e**
 * `itemsSeen > 0` (F2 do parecer da #46). A guarda de 80% decide o *status* do
 * run; o `is_active` é decidido pelo TTL de 28 dias, que roda como caminho
 * separado e por isso não é bloqueado pela guarda.
 *
 * Registro sem `source_key` (`https://` sozinho, que `httpsUrlOrNull` aceita) é
 * descartado na coleta: `items_seen` conta só o que pode virar linha.
 */
import {
  INGEST_ERROR_CODES,
  type CatalogRepository,
  type IngestRunFinish,
  type RotationBands,
  type RotationParams,
} from './catalog-repository';
import type { SkillRecord, SkillSource } from './skill-source';

/**
 * Falha ao **enumerar a fonte** (sitemap fora do ar), nao ao consultar o banco.
 *
 * Existe para o `ingest` classificar o run com o `error_code` certo: sem a marca,
 * um `SELECT` que falha e um sitemap que falha viravam o mesmo
 * `SOURCE_FETCH_FAILED`, e o alerta do 7.3 apontava para o lado errado.
 */
export class SourceEnumerationError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(detail, options);
    this.name = 'SourceEnumerationError';
  }
}

/** Slots por ciclo: 720 requisições a cada 6 h, ~3% de *duty cycle* (§7.3). */
export const CYCLE_SLOTS = 720;

/** Teto de chaves vindas do hot set (`search_request.result_ids` dos 7 dias). */
export const HOT_SLOTS = 360;

/** Idade mínima, em dias, para uma skill contar como fria e entrar no rodízio. */
export const COLD_MIN_DAYS = 7;

/** TTL da entrada de catálogo, em dias: vencida, gira primeiro. */
export const COLD_MAX_DAYS = 14;

/** Idade a partir da qual a skill é desativada — o único caminho de desativação. */
export const DEACTIVATION_TTL_DAYS = 28;

/** Idade a partir da qual um run `running` é considerado órfão. */
export const STALE_RUN_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * As frações ratificadas como **inteiros** (`5 × seen >= 4 × expected`): o
 * denominador é o mesmo dos dois lados, e comparar inteiros não depende da
 * representação binária de `0,8`. A decimal exportada é **derivada** da mesma
 * fração — não existe uma segunda cópia do número em ponto flutuante (F6 do
 * parecer da #46).
 */
const UPSERT_RATIO = { num: 1, den: 2 } as const; // 0,5
const COVERAGE = { num: 4, den: 5 } as const; // 0,8

/** Fração mínima do ciclo que precisa chegar ao banco. */
export const MIN_UPSERT_RATIO = UPSERT_RATIO.num / UPSERT_RATIO.den;

/** Fração mínima do ciclo que a fonte precisa ter entregue (guarda de 80%). */
export const MIN_CYCLE_COVERAGE = COVERAGE.num / COVERAGE.den;

/** Tamanho máximo de `error_detail` gravado/registrado. */
const ERROR_DETAIL_LIMIT = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Opções da execução; tudo o que é I/O ou relógio entra por aqui. */
export interface IngestOptions {
  readonly source: SkillSource;
  readonly repository: CatalogRepository;
  /** Nome do adaptador gravado em `ingest_run.adapter` (`fixture`, `html`). */
  readonly adapter: string;
  /** Relógio injetado: início do run e referência de `last_seen_at`. */
  readonly startedAt: Date;
  /**
   * Relógio de fechamento (`finished_at`), padrão o relógio real. Existe para
   * que `startedAt` continue sendo o único tempo que decide o run e para que um
   * teste possa fixar `finished_at` também.
   */
  readonly now?: () => Date;
}

/** Resultado da execução — eco do que foi gravado em `ingest_run`. */
export interface IngestRunOutcome {
  readonly status: 'ok' | 'partial' | 'failed';
  readonly items_requested: number;
  readonly items_seen: number;
  readonly items_upserted: number;
  readonly items_deactivated: number;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly started_at: Date;
  readonly finished_at: Date;
}

/** O que a fonte entregou para o ciclo pedido. */
interface CollectedSlice {
  /** Chaves distintas efetivamente pedidas (`items_requested`). */
  readonly requested: readonly string[];
  readonly items: readonly SkillRecord[];
  /** Mensagem da fonte que falhou; `null` quando ela respondeu. */
  readonly fetchError: string | null;
}

/** Executa a ingestão e devolve o que ficou gravado; nunca abre socket. */
export async function ingest(options: IngestOptions): Promise<IngestRunOutcome> {
  const { source, repository, adapter, startedAt } = options;
  const now = options.now ?? (() => new Date());

  // 1. Run órfão de um processo morto no meio vira `failed` / `STALE_RUN`.
  await repository.failStaleRuns(new Date(startedAt.getTime() - STALE_RUN_AGE_MS));

  // 2. O ciclo é montado **antes** de abrir o run: `items_requested` é o
  //    tamanho do ciclo e precisa ser conhecido já no `INSERT`. A exceção que
  //    pode sair daqui é a enumeração da fonte (`listKeys`, sitemap fora do
  //    ar) — e ela tem de deixar rastro: run `failed`/`SOURCE_FETCH_FAILED`
  //    com `items_requested: 0` (F3 do parecer da #46). Se quem lançar for o
  //    repositório, o `startRun` abaixo falha também e o erro sobe: aí não há
  //    linha para fechar.
  let keys: string[];
  try {
    keys = await selectCycleKeys(source, repository, startedAt);
  } catch (error) {
    const detail = describeError(error);
      // Banco fora do ar e sitemap fora do ar nao sao a mesma falha: a marca diz
      // qual lado caiu, e o `error_code` e o sinal de alerta do 7.3.
      const fromSource = error instanceof SourceEnumerationError;
    const failedAt = now();
    // `startRun` pode lançar (banco fora do ar): nesse caso não existe run a
    // registrar, e propagar o erro é a única resposta honesta.
    const failedRunId = await repository.startRun({
      adapter,
      started_at: startedAt,
      items_requested: 0,
    });
    await repository.finishRun(failedRunId, {
      status: 'failed',
      finished_at: failedAt,
      items_seen: 0,
      items_upserted: 0,
      items_deactivated: 0,
      error_code: fromSource
        ? INGEST_ERROR_CODES.sourceFetchFailed
        : INGEST_ERROR_CODES.repositoryFailed,
      error_detail: detail,
    });
    return {
      status: 'failed',
      items_requested: 0,
      items_seen: 0,
      items_upserted: 0,
      items_deactivated: 0,
      error_code: fromSource
        ? INGEST_ERROR_CODES.sourceFetchFailed
        : INGEST_ERROR_CODES.repositoryFailed,
      error_detail: detail,
      started_at: startedAt,
      finished_at: failedAt,
    };
  }

  // 3. O run novo é aberto antes de qualquer leitura da fonte.
  const runId = await repository.startRun({
    adapter,
    started_at: startedAt,
    items_requested: keys.length,
  });

  let itemsSeen = 0;
  let itemsUpserted = 0;
  let itemsDeactivated = 0;
  let status: 'ok' | 'partial' | 'failed' = 'failed';
  let errorCode: string | null = null;
  let errorDetail: string | null = null;

  try {
    const collected = await collectSlice(source, keys);
    // Chaves DISTINTAS, não itens recebidos: a razão upserted/requested e a
    // guarda de 80% só significam algo se numerador e denominador medirem a
    // mesma unidade. A fonte pode repetir a mesma chave no lote.
    itemsSeen = new Set(collected.items.map((item) => item.source_key)).size;

    if (itemsSeen > 0) {
      itemsUpserted = await repository.upsertSkills(toMutable(collected.items), startedAt);
    }

    const decided = decideStatus(
      collected.requested.length,
      itemsSeen,
      itemsUpserted,
      collected.fetchError,
    );
    status = decided.status;
    errorCode = decided.errorCode;
    errorDetail = decided.errorDetail;

    // 4. Expurgo por idade: caminho **separado** da guarda de 80%. Mede
    //    `last_seen_at`, não a cobertura deste ciclo — por isso roda também em
    //    `partial`. Duas condições o bloqueiam: run `failed` (fonte fora do ar,
    //    repositório lançando) e run que **não viu nada** (`itemsSeen === 0`):
    //    fonte que devolve zero não pode auto-desativar o catálogo (F2 do
    //    parecer da #46).
    if (status !== 'failed' && itemsSeen > 0) {
      itemsDeactivated = await repository.deactivateSkillsStaleBefore(
        new Date(startedAt.getTime() - DEACTIVATION_TTL_DAYS * DAY_MS),
      );
    }
  } catch (error) {
    // O repositório lançou (upsert/expurgo). O run não pode ficar `running`.
    status = 'failed';
    errorCode = INGEST_ERROR_CODES.repositoryFailed;
    errorDetail = describeError(error);
  }

  const finishedAt = now();
  const finish: IngestRunFinish = {
    status,
    finished_at: finishedAt,
    items_seen: itemsSeen,
    items_upserted: itemsUpserted,
    items_deactivated: itemsDeactivated,
    error_code: errorCode,
    error_detail: errorDetail,
  };
  await repository.finishRun(runId, finish);

  return {
    status,
    items_requested: keys.length,
    items_seen: itemsSeen,
    items_upserted: itemsUpserted,
    items_deactivated: itemsDeactivated,
    error_code: errorCode,
    error_detail: errorDetail,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

/**
 * As chaves do ciclo, na prioridade ratificada (F1 do parecer da #46).
 *
 * O universo do rodízio é o conjunto de chaves da **fonte**, não o conjunto de
 * linhas do banco. `selectRotationKeys` devolve as bandas **separadas** — hot
 * (demanda real) e cold (o resto) — e `selectUnseenKeys` responde quais chaves
 * que a fonte enumera ainda não são linha ativa. `planCycle` monta o ciclo:
 *
 * 1. **hot**, até `HOT_SLOTS`: frescor, D3 ("hot ≤ 6 h"). Nunca faminto;
 * 2. **inéditas**, ocupando a cota de descoberta que sobra do hot: **nunca
 *    famintas enquanto existirem** — é o que impede o catálogo de travar nas
 *    primeiras 720 linhas;
 * 3. **cold**, preenchendo o resto (as mais antigas primeiro).
 *
 * Duas guardas de orçamento:
 *
 * - **cota de descoberta reservada antes do cold**: `listKeys()` é chamado
 *   sempre que existe cota — o que, com `HOT_SLOTS < CYCLE_SLOTS`, é todo
 *   ciclo. A enumeração não depende de o rodízio estar cheio: é justamente o
 *   caso "catálogo com 20.000 linhas" que precisa descobrir o resto. O adaptador
 *   memoiza a enumeração por instância, então o `sitemap.xml` é lido uma vez por
 *   processo; se ela lançar, o run termina como `failed` com rastro (F3);
 * - `hot ∪ cold` vazio **e** `countActiveSkills() > 0`: defeito do seletor. Não
 *   se inventa trabalho na fonte para encobri-lo; `items_requested: 0` e
 *   `EMPTY_CATALOG` dizem o que aconteceu. Catálogo vazio (`countActiveSkills()
 *   === 0`) é bootstrap: todas as chaves da fonte são inéditas.
 */
async function selectCycleKeys(
  source: SkillSource,
  repository: CatalogRepository,
  startedAt: Date,
): Promise<string[]> {
  const params: RotationParams = {
    now: startedAt,
    hotSlots: HOT_SLOTS,
    coldMinDays: COLD_MIN_DAYS,
    coldMaxDays: COLD_MAX_DAYS,
    cycleSlots: CYCLE_SLOTS,
  };
  const bands = await repository.selectRotationKeys(params);
  const hot = uniqueKeys(bands.hot);
  const cold = uniqueKeys(bands.cold);
  const rotated = hot.length + cold.length;

  if (rotated === 0 && (await repository.countActiveSkills()) > 0) {
    return [];
  }
  // A enumeracao da FONTE e a unica excecao que pode sair daqui. Marcamos o erro:
  // sem marca, o `ingest` registraria falha de BANCO como `SOURCE_FETCH_FAILED`
  // e culparia a fonte (MEDIUM do parecer da #46).
  let listed: readonly string[];
  try {
    listed = uniqueKeys(await source.listKeys());
  } catch (error) {
    throw new SourceEnumerationError(describeError(error), { cause: error });
  }
  // Sem linha ativa nenhuma (bootstrap), toda chave enumerada é inédita por
  // construção: a pergunta ao banco seria "nada está ativo", já respondida.
  const unseen = rotated === 0 ? listed : await repository.selectUnseenKeys(listed);

  return planCycle({ hot, cold, unseen }, { cycleSlots: CYCLE_SLOTS, hotSlots: HOT_SLOTS });
}

/** Chaves distintas, na ordem em que vieram. */
function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

/** As três bandas com que o ciclo é montado. */
export interface CycleBands extends RotationBands {
  /** Chaves que a fonte enumera e o catálogo não tem como linha ativa. */
  readonly unseen: readonly string[];
}

/** Orçamentos ratificados de um ciclo (D3): teto total e teto do hot. */
export interface CycleBudget {
  /** Chaves por ciclo — o teto duro de `items_requested`. */
  readonly cycleSlots: number;
  /** Teto do hot set; o que o hot não usar é cota de descoberta. */
  readonly hotSlots: number;
}

/**
 * Monta o ciclo, **puro e determinístico**: mesma entrada ⇒ mesma saída, sem
 * relógio, sem `Math.random` e sem tocar na fonte ou no banco — o `ingest` faz
 * as leituras e entrega as bandas aqui.
 *
 * Prioridade ratificada (F1 do parecer da #46), nesta ordem:
 *
 * 1. **hot** — até `hotSlots`. É demanda real (`search_request.result_ids`), tem
 *    de estar fresco e nunca é cortado em favor de descoberta;
 * 2. **inéditas** — em ordem de code units (a mesma do `COLLATE "C"` do
 *    Postgres, para o ciclo não depender da ordem do `Set` do sitemap). Ocupam
 *    **toda a cota de descoberta** que sobrou do hot, sempre antes do cold;
 * 3. **cold** — preenche o que ainda couber, na ordem em que o repositório o
 *    devolveu (vencidas primeiro, depois as mais antigas).
 *
 * Corte em `cycleSlots`, sem repetir chave: a inédita que também está no
 * rodízio é pedida uma vez, na posição da banda que veio primeiro.
 */
export function planCycle(bands: CycleBands, budget: CycleBudget): string[] {
  const cycle = Math.max(0, budget.cycleSlots);
  const hotSlots = Math.max(0, Math.min(budget.hotSlots, cycle));
  const keys: string[] = [];
  const chosen = new Set<string>();

  for (const key of bands.hot) {
    if (keys.length >= hotSlots) {
      break;
    }
    pushUnique(keys, chosen, key);
  }

  for (const key of uniqueKeys(bands.unseen).sort(compareKeys)) {
    if (keys.length >= cycle) {
      break;
    }
    pushUnique(keys, chosen, key);
  }

  for (const key of bands.cold) {
    if (keys.length >= cycle) {
      break;
    }
    pushUnique(keys, chosen, key);
  }

  return keys;
}

/** Ordem de `source_key` por code units — a mesma de `COLLATE "C"` no Postgres. */
function compareKeys(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Empurra a chave uma única vez, preservando a primeira posição em que entrou. */
function pushUnique(keys: string[], chosen: Set<string>, key: string): void {
  if (chosen.has(key)) {
    return;
  }
  chosen.add(key);
  keys.push(key);
}

/**
 * Pede as chaves do ciclo à fonte. Uma falha aqui é do run inteiro: com uma
 * única chamada não existe "meia página lida", e o catálogo anterior continua
 * valendo (`is_active` não é tocado).
 */
async function collectSlice(source: SkillSource, keys: readonly string[]): Promise<CollectedSlice> {
  if (keys.length === 0) {
    return { requested: keys, items: [], fetchError: null };
  }
  try {
    const items = await source.fetchSkills(keys);
    // Registro sem `source_key` não é skill: `httpsUrlOrNull('https://')` aceita
    // a URL, mas o path não tem segmento nenhum e a linha ficaria com chave
    // vazia (o contrato diz "nunca vazio" e a coluna é `NOT NULL`).
    return { requested: keys, items: items.filter(isIngestable), fetchError: null };
  } catch (error) {
    return { requested: keys, items: [], fetchError: describeError(error) };
  }
}

/** Só entra no run o registro que tem chave — o resto é lixo de scraping. */
function isIngestable(skill: SkillRecord): boolean {
  return skill.source_key.length > 0;
}

/** A tabela ratificada do §7.3, em uma função pura (ordem fixada pelo F2). */
function decideStatus(
  requested: number,
  itemsSeen: number,
  itemsUpserted: number,
  fetchError: string | null,
): { status: 'ok' | 'partial' | 'failed'; errorCode: string | null; errorDetail: string | null } {
  // 1. A fonte lançou antes de entregar: o run não entregou nem o que pediu.
  if (fetchError !== null) {
    return {
      status: 'failed',
      errorCode: INGEST_ERROR_CODES.sourceFetchFailed,
      errorDetail: fetchError,
    };
  }

  // 2. Nenhuma chave no ciclo → nada a girar, catálogo preservado.
  if (requested === 0) {
    return { status: 'partial', errorCode: INGEST_ERROR_CODES.emptyCatalog, errorDetail: null };
  }

  // 3. Pediu e não viu nada, sem erro: cobertura zero do ciclo. Antes caía em
  //    `EMPTY_CATALOG`, que é sobre o **ciclo** vazio, não sobre a fonte muda.
  if (itemsSeen === 0) {
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.lowCycleCoverage,
      errorDetail: null,
    };
  }

  // 4. Guarda de 80% sobre o ciclo (a mesma fração de `MIN_CYCLE_COVERAGE`).
  if (!meetsRatio(itemsSeen, requested, COVERAGE.num, COVERAGE.den)) {
    // O ciclo não viu o que pediu. Mede **contra o ciclo**, não contra os
    // 20.000 ativos — 720 de 20.000 é rodízio, não falha.
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.lowCycleCoverage,
      errorDetail: null,
    };
  }

  // 5. Razão de upsert (a mesma fração de `MIN_UPSERT_RATIO`).
  if (!meetsRatio(itemsUpserted, requested, UPSERT_RATIO.num, UPSERT_RATIO.den)) {
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.lowUpsertRatio,
      errorDetail: null,
    };
  }

  return { status: 'ok', errorCode: null, errorDetail: null };
}

/**
 * `observed / expected >= numerator / denominator`, em aritmética inteira
 * (`denominator × observed >= numerator × expected`) para não depender da
 * representação binária de `0,8`.
 */
function meetsRatio(
  observed: number,
  expected: number,
  numerator: number,
  denominator: number,
): boolean {
  return denominator * observed >= numerator * expected;
}

/** A porta aceita `SkillRecord[]`; a coleta interna é só leitura. */
function toMutable(skills: readonly SkillRecord[]): SkillRecord[] {
  return skills.slice();
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_DETAIL_LIMIT ? message.slice(0, ERROR_DETAIL_LIMIT) : message;
}
