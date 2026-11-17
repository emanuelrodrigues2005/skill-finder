/**
 * Orquestração do `IngestRun` (`docs/app/02-arquitetura.md` §7.3).
 *
 * Sem banco, sem docker, sem rede: recebe a fonte e o repositório por injeção e
 * decide o destino do run. O relógio também é injetado — `startedAt` é
 * parâmetro e o corte de run órfão sai dele (`startedAt - 2 h`), nunca de
 * `new Date()` lido no meio da decisão.
 *
 * Tabela ratificada (transições `running -> ok | partial | failed`):
 *
 *   | condição                                                   | status  |
 *   | fonte lança antes de gravar / repositório lança              | failed  |
 *   | items_seen == 0, página falhou, ou upserted/seen < 0,5       | partial |
 *   | caso contrário, com items_seen >= 1                          | ok      |
 *
 * Desativação **só** em `ok` **e** com `items_seen >= 0,8 × ativos`: uma
 * resposta parcial não pode zerar o catálogo. O upsert também reativa
 * (`is_active = true`) tudo que foi visto.
 *
 * Registro sem `source_key` (`https://` sozinho, que `httpsUrlOrNull` aceita)
 * é descartado na coleta: `items_seen` conta só o que pode virar linha.
 */
import {
  INGEST_ERROR_CODES,
  type CatalogRepository,
  type IngestRunFinish,
} from './catalog-repository';
import type { CatalogPage, SkillRecord, SkillSource } from './skill-source';

/** Teto de páginas por execução (§7.3). */
export const MAX_PAGES = 200;

/** Idade a partir da qual um run `running` é considerado órfão. */
export const STALE_RUN_AGE_MS = 2 * 60 * 60 * 1000;

/** Fração mínima de itens lidos que precisa chegar ao banco. */
const MIN_UPSERT_RATIO = 0.5;

/** Fração mínima de ativos vistos para autorizar a desativação (§7.3, passo 5). */
const DEACTIVATION_GUARD_NUMERATOR = 4; // 0,8 = 4/5
const DEACTIVATION_GUARD_DENOMINATOR = 5;

/** Tamanho máximo de `error_detail` gravado/registrado. */
const ERROR_DETAIL_LIMIT = 500;

/** Opções da execução; tudo o que é I/O ou relógio entra por aqui. */
export interface IngestOptions {
  readonly source: SkillSource;
  readonly repository: CatalogRepository;
  /** Nome do adaptador gravado em `ingest_run.adapter` (`fixture`, `json`, `html`). */
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
  readonly items_seen: number;
  readonly items_upserted: number;
  readonly items_deactivated: number;
  readonly error_code: string | null;
  readonly error_detail: string | null;
  readonly started_at: Date;
  readonly finished_at: Date;
}

/** Páginas lidas até a fonte esgotar, falhar ou bater o teto. */
interface CollectedPages {
  readonly items: readonly SkillRecord[];
  /** Mensagem da página que falhou; `null` quando todas responderam. */
  readonly pageError: string | null;
  /** `true` quando o teto de páginas foi atingido com `has_more` ainda ligado. */
  readonly pageLimitHit: boolean;
}

/** Executa a ingestão e devolve o que ficou gravado; nunca abre socket. */
export async function ingest(options: IngestOptions): Promise<IngestRunOutcome> {
  const { source, repository, adapter, startedAt } = options;
  const now = options.now ?? (() => new Date());

  // 1. Run órfão de um processo morto no meio vira `failed` / `STALE_RUN`.
  await repository.failStaleRuns(new Date(startedAt.getTime() - STALE_RUN_AGE_MS));

  // 2. O run novo é aberto antes de qualquer leitura: falha de fonte é run fechado.
  const runId = await repository.startRun({ adapter, started_at: startedAt });

  let itemsSeen = 0;
  let itemsUpserted = 0;
  let itemsDeactivated = 0;
  let status: 'ok' | 'partial' | 'failed' = 'failed';
  let errorCode: string | null = null;
  let errorDetail: string | null = null;

  try {
    const collected = await collectPages(source);
    // Chaves DISTINTAS, não itens recebidos: a razão upserted/seen e a guarda de
    // 80% só significam algo se numerador e denominador medirem a mesma unidade.
    // Com duplicata (o site lista a mesma skill em destaque e na listagem), contar
    // itens inflava o denominador e marcava `partial` sem nada estar errado.
    itemsSeen = new Set(collected.items.map((item) => item.source_key)).size;

    // A guarda de 80% compara com o catálogo **antes** do upsert: contado depois,
    // o próprio upsert inflaria a base e a guarda nunca protegeria nada.
    const activeBefore = itemsSeen > 0 ? await repository.countActiveSkills() : 0;
    if (itemsSeen > 0) {
      itemsUpserted = await repository.upsertSkills(toMutable(collected.items), startedAt);
    }

    const decided = decideStatus(itemsSeen, itemsUpserted, collected);
    status = decided.status;
    errorCode = decided.errorCode;
    errorDetail = decided.errorDetail;

    if (status === 'ok' && meetsDeactivationGuard(itemsSeen, activeBefore)) {
      itemsDeactivated = await repository.deactivateSkillsNotSeenSince(startedAt);
    }
  } catch (error) {
    // O repositório lançou (upsert/contagem). O run não pode ficar `running`.
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
    items_seen: itemsSeen,
    items_upserted: itemsUpserted,
    items_deactivated: itemsDeactivated,
    error_code: errorCode,
    error_detail: errorDetail,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

/** Itera páginas até `has_more` desligar, uma página falhar ou o teto estourar. */
async function collectPages(source: SkillSource): Promise<CollectedPages> {
  const items: SkillRecord[] = [];
  let pageError: string | null = null;
  let page = 1;

  for (; page <= MAX_PAGES; page += 1) {
    let result: CatalogPage;
    try {
      result = await source.fetchCatalog(page);
    } catch (error) {
      pageError = describeError(error);
      break;
    }
    // Registro sem `source_key` não é skill: `httpsUrlOrNull('https://')`
    // aceita a URL, mas o path não tem segmento nenhum e a linha ficaria com
    // chave vazia (o contrato diz "nunca vazio" e a coluna é `NOT NULL`).
    // Descartar aqui mantém `items_seen` contando só o que pode ser gravado.
    items.push(...result.items.filter(isIngestable));
    if (!result.has_more) {
      break;
    }
  }

  return { items, pageError, pageLimitHit: page > MAX_PAGES };
}

/** Só entra no run o registro que tem chave — o resto é lixo de scraping. */
function isIngestable(skill: SkillRecord): boolean {
  return skill.source_key.length > 0;
}

/** A tabela ratificada do §7.3, em uma função pura. */
function decideStatus(
  itemsSeen: number,
  itemsUpserted: number,
  collected: CollectedPages,
): { status: 'ok' | 'partial' | 'failed'; errorCode: string | null; errorDetail: string | null } {
  if (itemsSeen === 0) {
    // Fonte lançou antes de gravar → `failed`. Fonte respondeu vazia → `partial`:
    // o catálogo anterior continua válido, mas a ingestão não entregou nada.
    return collected.pageError === null
      ? {
          status: 'partial',
          errorCode: INGEST_ERROR_CODES.emptyCatalog,
          errorDetail: null,
        }
      : {
          status: 'failed',
          errorCode: INGEST_ERROR_CODES.sourceFetchFailed,
          errorDetail: collected.pageError,
        };
  }

  if (collected.pageError !== null) {
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.pageFetchFailed,
      errorDetail: collected.pageError,
    };
  }

  if (collected.pageLimitHit) {
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.pageLimitReached,
      errorDetail: null,
    };
  }

  if (itemsUpserted / itemsSeen < MIN_UPSERT_RATIO) {
    return {
      status: 'partial',
      errorCode: INGEST_ERROR_CODES.lowUpsertRatio,
      errorDetail: null,
    };
  }

  return { status: 'ok', errorCode: null, errorDetail: null };
}

/**
 * `itemsSeen >= 0,8 × ativos`, em aritmética inteira (`5 × seen >= 4 × active`)
 * para não depender da representação binária de `0,8`.
 */
function meetsDeactivationGuard(itemsSeen: number, activeBefore: number): boolean {
  return itemsSeen * DEACTIVATION_GUARD_DENOMINATOR >= activeBefore * DEACTIVATION_GUARD_NUMERATOR;
}

/** A porta aceita `SkillRecord[]`; a coleta interna é só leitura. */
function toMutable(skills: readonly SkillRecord[]): SkillRecord[] {
  return skills.slice();
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > ERROR_DETAIL_LIMIT ? message.slice(0, ERROR_DETAIL_LIMIT) : message;
}
