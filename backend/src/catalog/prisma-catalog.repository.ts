/**
 * Implementação Prisma/Postgres da porta do catálogo (`docs/app/02-arquitetura.md`
 * §7.3, migration `c57b3ac`).
 *
 * `search_doc` é `Unsupported("tsvector")` no Prisma Schema: não existe campo
 * gerado para ele, então o upsert é **SQL bruto** (`$executeRaw`). É a única
 * forma de manter a coluna coerente com `name || ' ' || summary` sem um trigger.
 *
 * O upsert é uma statement por lote (`ON CONFLICT (source_key) DO UPDATE`),
 * atômica por lote e em transação entre lotes:
 * - **uma linha por `source_key` distinta**: a mesma chave repetida no lote é
 *   fundida na última ocorrência antes de montar a statement — o Postgres
 *   recusa a statement inteira se a mesma linha for tocada duas vezes
 *   (`21000: ON CONFLICT DO UPDATE command cannot affect row a second time`), e
 *   como os lotes rodam numa única transação isso derrubaria o run todo;
 * - `is_active = true` para tudo que foi visto nesta execução;
 * - `last_seen_at = seenAt` (o `startedAt` injetado, nunca `now()`);
 * - `first_seen_at = LEAST(skill.first_seen_at, EXCLUDED.first_seen_at)`, com
 *   fallback para `seenAt` quando a fonte não data a primeira aparição (a
 *   coluna é `NOT NULL`);
 * - `search_doc = to_tsvector('english', name || ' ' || coalesce(summary, ''))`.
 *
 * Na mesma transação, cada lote grava `skill_metric_snapshot` (`captured_at =
 * seenAt` do run, nunca `now()`) **só quando a métrica mudou** desde o último
 * snapshot daquela skill (§7.3, passo 4). A sobrescrita de `skill.stars` e
 * `skill.installs` continua sendo o sinal de falha do seletor
 * (`docs/app/02-arquitetura.md`:443) — nada de `COALESCE` preservando valor
 * antigo; o que impede a perda definitiva do dado é a série histórica.
 */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

import {
  INGEST_ERROR_CODES,
  type CatalogRepository,
  type IngestRunFinish,
  type RotationBands,
  type RotationCandidate,
  type RotationParams,
} from './catalog-repository';
import type { SkillRecord } from './skill-source';

export type { RotationBands, RotationCandidate, RotationParams } from './catalog-repository';

/**
 * Linhas por statement: `search_doc` acrescenta parâmetros e o teto do Postgres
 * é de 65 535 por query. 500 linhas deixam folga larga.
 */
const UPSERT_CHUNK_SIZE = 500;

/**
 * Chaves por statement em `selectUnseenKeys`: um `IN` de uma coluna aguenta
 * muito mais que o do upsert, mas a lista vem do `sitemap.xml` inteiro (~20.000)
 * e o teto de parâmetros do Postgres é 65 535 — 5.000 por lote deixa margem para
 * um catálogo bem maior que o ratificado.
 */
const UNSEEN_CHUNK_SIZE = 5_000;

/**
 * Janela do hot set, em dias (F2.10 / D3). Separada de `coldMinDays` de
 * propósito: são ratificados com o mesmo valor hoje (7), mas significam coisas
 * diferentes — aqui é "o que foi pedido recentemente", ali é "o que já pode
 * girar".
 */
const HOT_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Repositório de produção: toda a escrita passa por statement explícita. */
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * `running` mais velho que o corte vira `failed` / `STALE_RUN` (§7.3).
   *
   * `finished_at` entra com `COALESCE(finished_at, now())`: todo run terminal
   * legítimo tem horário de fechamento, e a porta já fixada não recebe o
   * "agora" da ingestão — o relógio do varrido é o do banco.
   */
  async failStaleRuns(startedBefore: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "ingest_run"
         SET status = 'failed'::"IngestStatus",
             error_code = ${INGEST_ERROR_CODES.staleRun},
             finished_at = COALESCE(finished_at, now())
       WHERE status = 'running'::"IngestStatus"
         AND started_at < ${startedBefore}
    `;
  }

  async startRun(run: {
    adapter: string;
    started_at: Date;
    items_requested?: number | null;
  }): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO "ingest_run" (adapter, started_at, status, items_requested)
      VALUES (
        ${run.adapter},
        ${run.started_at},
        'running'::"IngestStatus",
        ${run.items_requested ?? null}
      )
      RETURNING id
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error('INSERT em ingest_run não devolveu id');
    }
    return Number(row.id);
  }

  async finishRun(id: number, patch: IngestRunFinish): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "ingest_run"
         SET status = ${patch.status}::"IngestStatus",
             finished_at = ${patch.finished_at},
             items_seen = ${patch.items_seen},
             items_upserted = ${patch.items_upserted},
             items_deactivated = ${patch.items_deactivated},
             error_code = ${patch.error_code ?? null},
             error_detail = ${patch.error_detail ?? null}
       WHERE id = ${BigInt(id)}
    `;
  }

  async countActiveSkills(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ active: bigint }>>`
      SELECT count(*)::bigint AS active FROM "skill" WHERE is_active = true
    `;
    const row = rows[0];
    return row === undefined ? 0 : Number(row.active);
  }

  /**
   * As chaves do ciclo de rodízio (F2.10 / D3), **por banda**: hot primeiro,
   * cold depois — a prioridade entre as duas é de `planCycle` (`ingest.ts`),
   * porque a cota de descoberta é reservada no meio (F1 do parecer da #46).
   *
   * Duas consultas, ambas ancoradas em `params.now` — nada de `now()` do banco,
   * senão a mesma chamada devolveria outra lista a cada segundo:
   *
   * 1. **hot**: `source_key` das skills ativas que apareceram em
   *    `search_request.result_ids` nos últimos 7 dias, ordenadas pela
   *    requisição mais recente e limitadas a `hotSlots`. É a demanda real: o que
   *    o usuário procurou tem de estar fresco.
   * 2. **cold**: o resto das ativas (`is_active`), menos as do hot pool — por
   *    isso o `NOT EXISTS` sobre o mesmo `unnest`, e não só sobre as 360
   *    escolhidas: "cold = o resto" é sobre o conjunto quente inteiro.
   *
   * O cold usa o índice `(is_active, last_seen_at)` (migration da #45), que é o
   * que impede um `seq scan` de 20.000 linhas a cada 6 h — o `LIMIT` continua
   * sendo o do ciclo: o que não couber volta no ciclo seguinte, na mesma ordem.
   */
  async selectRotationKeys(params: RotationParams): Promise<RotationBands> {
    const hotSince = daysBefore(params.now, HOT_WINDOW_DAYS);
    const cycleSlots = Math.max(0, params.cycleSlots);
    const hotLimit = Math.max(0, Math.min(params.hotSlots, cycleSlots));

    const hotRows =
      hotLimit === 0
        ? []
        : await this.prisma.$queryRaw<HotRow[]>`
            SELECT s.source_key AS source_key,
                   max(sr.created_at) AS requested_at,
                   s.last_seen_at AS last_seen_at
              FROM "search_request" AS sr
              CROSS JOIN LATERAL unnest(sr.result_ids) AS rid(skill_id)
              JOIN "skill" AS s ON s.id = rid.skill_id
             WHERE sr.created_at >= ${hotSince}
               AND s.is_active = true
             GROUP BY s.source_key, s.last_seen_at
             ORDER BY max(sr.created_at) DESC, s.source_key COLLATE "C" ASC
             LIMIT ${hotLimit}
          `;

    const coldCapacity = cycleSlots - hotRows.length;
    const coldRows =
      coldCapacity <= 0
        ? []
        : await this.prisma.$queryRaw<ColdRow[]>`
            WITH hot AS (
              SELECT DISTINCT rid.skill_id AS skill_id
                FROM "search_request" AS sr
                CROSS JOIN LATERAL unnest(sr.result_ids) AS rid(skill_id)
               WHERE sr.created_at >= ${hotSince}
            )
            SELECT s.source_key AS source_key,
                   s.last_seen_at AS last_seen_at
              FROM "skill" AS s
             WHERE s.is_active = true
               AND NOT EXISTS (SELECT 1 FROM hot WHERE hot.skill_id = s.id)
             ORDER BY (s.last_seen_at <= ${daysBefore(params.now, params.coldMinDays)}) DESC,
                      (s.last_seen_at <= ${daysBefore(params.now, params.coldMaxDays)}) DESC,
                      s.last_seen_at ASC,
                      s.source_key COLLATE "C" ASC
             LIMIT ${coldCapacity}
          `;

    return orderRotationBands(params, {
      hot: hotRows.map(toHotCandidate),
      cold: coldRows.map(toColdCandidate),
    });
  }

  /**
   * As **inéditas** do ciclo: das chaves que a fonte enumerou, as que não são
   * linha ativa do catálogo (F1 do parecer da #46).
   *
   * Uma consulta por lote, com `is_active = true`: linha inativa **conta como
   * inédita** de propósito — ela saiu do rodízio pelo TTL de 28 dias e é
   * reaparecendo na fonte que volta a ficar ativa. A ordem de entrada é a da
   * fonte; quem ordena é `planCycle` (`COLLATE "C"` em TS), para a regra ser
   * provada sem banco.
   */
  async selectUnseenKeys(candidates: readonly string[]): Promise<string[]> {
    const unique = [...new Set(candidates)];
    if (unique.length === 0) {
      return [];
    }
    const active = new Set<string>();
    for (const batch of chunk(unique, UNSEEN_CHUNK_SIZE)) {
      const rows = await this.prisma.$queryRaw<Array<{ source_key: string }>>`
        SELECT source_key
          FROM "skill"
         WHERE is_active = true
           AND source_key IN (${Prisma.join(batch)})
      `;
      for (const row of rows) {
        active.add(row.source_key);
      }
    }
    return unique.filter((key) => !active.has(key));
  }

  /**
   * Upsert por `source_key`, **uma linha por chave distinta** (a última
   * ocorrência do lote vence), mais o snapshot de métrica das chaves do lote.
   * Devolve quantas linhas de `skill` foram gravadas — o número de chaves
   * distintas, não o de itens recebidos.
   */
  async upsertSkills(skills: SkillRecord[], seenAt: Date): Promise<number> {
    const unique = dedupeBySourceKey(skills);
    if (unique.length === 0) {
      return 0;
    }
    // O snapshot vem depois do upsert do próprio lote, na mesma transação: o
    // `SELECT ... FROM "skill"` enxerga as linhas que a transação acabou de
    // gravar, inclusive as novas.
    const statements = chunk(unique, UPSERT_CHUNK_SIZE).flatMap((batch) => [
      this.prisma.$executeRaw(buildUpsertStatement(batch, seenAt)),
      this.prisma.$executeRaw(buildMetricSnapshotStatement(batch, seenAt)),
    ]);
    await this.prisma.$transaction(statements);
    return unique.length;
  }

  /**
   * Expurgo por TTL — **o único caminho de desativação** desde a #46:
   * `is_active = false` para o que não é visto desde `cutoff` (28 dias, D3),
   * numa passada por `last_seen_at`, nunca por lista de ids.
   *
   * O corte vem de fora (o chamador calcula `startedAt - 28 d`): o expurgo não
   * empresta o relógio de nenhum run, e a statement não usa `now()`.
   */
  async deactivateSkillsStaleBefore(cutoff: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "skill"
         SET is_active = false
       WHERE is_active = true
         AND last_seen_at < ${cutoff}
    `;
  }
}

/** Uma linha do hot set, como o `$queryRaw` devolve. */
interface HotRow {
  readonly source_key: string;
  readonly requested_at: Date;
  readonly last_seen_at: Date;
}

/** Uma linha do cold set. */
interface ColdRow {
  readonly source_key: string;
  readonly last_seen_at: Date;
}

/** Os dois conjuntos já lidos do banco: o único dado que a fusão precisa. */
export interface RotationPool {
  readonly hot: readonly RotationCandidate[];
  readonly cold: readonly RotationCandidate[];
}

/**
 * Ordena e corta as duas bandas do rodízio. **Pura e determinística**: mesma
 * entrada ⇒ mesma saída, sem relógio e sem `Math.random` (o `now` vem em
 * `params`).
 *
 * A mesma ordenação está escrita duas vezes de propósito: no SQL de
 * `selectRotationKeys`, para o `LIMIT` cortar as linhas certas usando o índice,
 * e aqui, para a regra ser provada sem banco. As duas cópias precisam andar
 * juntas — o spec unitário é o que as mantém honestas.
 *
 * Ordem dentro de cada banda:
 * 1. **hot**, pela requisição mais recente; empate resolvido por `sourceKey`
 *    crescente (comparação de code units, a mesma do `COLLATE "C"` do SQL).
 * 2. **cold**, as vencidas (fora do TTL de `coldMaxDays`) primeiro, depois as
 *    frias (`coldMinDays`), e dentro de cada grupo as mais antigas; empate por
 *    `sourceKey` crescente.
 *
 * Os cortes: hot em `hotSlots`, cold no que resta do ciclo depois do hot.
 * Chave que aparece nos dois conjuntos conta **uma vez**, na banda do hot — é o
 * "sem repetir chave entre hot e cold" da issue — e não consome slot do cold.
 *
 * A fusão (com a cota de descoberta no meio) é de `planCycle`, em `ingest.ts`:
 * aqui as bandas saem **separadas**, que é o que permite reservar a descoberta
 * antes do cold.
 */
export function orderRotationBands(params: RotationParams, pool: RotationPool): RotationBands {
  const cycleSlots = Math.max(0, params.cycleSlots);
  const hotSlots = Math.max(0, Math.min(params.hotSlots, cycleSlots));
  const coldSince = daysBefore(params.now, params.coldMinDays);
  const expiredSince = daysBefore(params.now, params.coldMaxDays);

  const chosen = new Set<string>();

  const hot: string[] = [];
  const byRecency = [...pool.hot].sort((left, right) => {
    const byRequest = time(right.requestedAt) - time(left.requestedAt);
    return byRequest !== 0 ? byRequest : compareKeys(left.sourceKey, right.sourceKey);
  });
  for (const candidate of byRecency) {
    if (hot.length >= hotSlots) {
      break;
    }
    pushUnique(hot, chosen, candidate.sourceKey);
  }

  const cold: string[] = [];
  const coldCapacity = cycleSlots - hot.length;
  const byStaleness = [...pool.cold].sort((left, right) => {
    const byBand = coldBand(left, coldSince) - coldBand(right, coldSince);
    if (byBand !== 0) {
      return byBand;
    }
    const byExpiry = coldBand(left, expiredSince) - coldBand(right, expiredSince);
    if (byExpiry !== 0) {
      return byExpiry;
    }
    const byAge = left.lastSeenAt.getTime() - right.lastSeenAt.getTime();
    return byAge !== 0 ? byAge : compareKeys(left.sourceKey, right.sourceKey);
  });
  for (const candidate of byStaleness) {
    if (cold.length >= coldCapacity) {
      break;
    }
    pushUnique(cold, chosen, candidate.sourceKey);
  }

  return { hot, cold };
}

/** `0` para quem cruzou o corte, `1` para quem ainda está dentro dele. */
function coldBand(candidate: RotationCandidate, cutoff: Date): number {
  return candidate.lastSeenAt.getTime() <= cutoff.getTime() ? 0 : 1;
}

/** `Date` em ms; `null` (cold sem requisição) vai para o fim da fila do hot. */
function time(moment: Date | null): number {
  return moment === null ? Number.NEGATIVE_INFINITY : moment.getTime();
}

/**
 * Ordem de `source_key` por code units — a mesma de `COLLATE "C"` no Postgres.
 * `localeCompare` seguiria o locale do processo e divergiria da consulta.
 */
function compareKeys(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function pushUnique(keys: string[], chosen: Set<string>, sourceKey: string): void {
  if (chosen.has(sourceKey)) {
    return;
  }
  chosen.add(sourceKey);
  keys.push(sourceKey);
}

/** `moment - days`, em ms: aritmética sobre o instante injetado, nunca `now()`. */
function daysBefore(moment: Date, days: number): Date {
  return new Date(moment.getTime() - days * DAY_MS);
}

function toHotCandidate(row: HotRow): RotationCandidate {
  return {
    sourceKey: row.source_key,
    requestedAt: row.requested_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toColdCandidate(row: ColdRow): RotationCandidate {
  return { sourceKey: row.source_key, requestedAt: null, lastSeenAt: row.last_seen_at };
}

/**
 * Um `INSERT ... ON CONFLICT (source_key) DO UPDATE` para o lote inteiro.
 *
 * Exportada para que a suíte possa provar a forma da statement sem banco
 * (colunas do `SET`, parametrização, contagem de valores). A função funde
 * chaves repetidas por conta própria: nenhuma statement sai daqui com a mesma
 * `source_key` duas vezes, que é o que o Postgres recusa com `21000`.
 */
export function buildUpsertStatement(batch: readonly SkillRecord[], seenAt: Date): Prisma.Sql {
  const values = Prisma.join(
    dedupeBySourceKey(batch).map(
      (skill) => Prisma.sql`(
        ${skill.source_key},
        ${skill.source_url},
        ${skill.category_slug},
        ${skill.name},
        ${skill.summary},
        ${skill.repo_url},
        ${skill.stars},
        ${skill.installs},
        ${skill.vulnerability_count},
        ${skill.security_status}::"SecurityStatus",
        ${skill.skill_md_present},
        ${skill.first_seen_at ?? seenAt},
        ${seenAt},
        true,
        ${JSON.stringify(skill.raw ?? null)}::jsonb,
        to_tsvector(
          'english',
          ${skill.name}::text || ' ' || coalesce(${skill.summary}::text, '')
        )
      )`,
    ),
  );

  return Prisma.sql`
    INSERT INTO "skill" (
      source_key, source_url, category_slug, name, summary, repo_url, stars, installs,
      vulnerability_count, security_status, skill_md_present, first_seen_at, last_seen_at,
      is_active, raw, search_doc
    )
    VALUES ${values}
    ON CONFLICT (source_key) DO UPDATE SET
      source_url = EXCLUDED.source_url,
      category_slug = EXCLUDED.category_slug,
      name = EXCLUDED.name,
      summary = EXCLUDED.summary,
      repo_url = EXCLUDED.repo_url,
      stars = EXCLUDED.stars,
      installs = EXCLUDED.installs,
      vulnerability_count = EXCLUDED.vulnerability_count,
      security_status = EXCLUDED.security_status,
      skill_md_present = EXCLUDED.skill_md_present,
      first_seen_at = LEAST("skill".first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = EXCLUDED.last_seen_at,
      is_active = true,
      raw = EXCLUDED.raw,
      search_doc = to_tsvector(
        'english',
        EXCLUDED.name || ' ' || coalesce(EXCLUDED.summary, '')
      )  `;
}

/**
 * `skill_metric_snapshot` para as chaves do lote, com `captured_at = seenAt`.
 *
 * Grava **só quando a métrica mudou** em relação ao último snapshot anterior
 * da skill (`IS NOT DISTINCT FROM` compara `NULL` com `NULL` como igual). Um
 * segundo run com as mesmas métricas não insere linha nenhuma; o
 * `ON CONFLICT (skill_id, captured_at) DO NOTHING` cobre o rerun no mesmo
 * `startedAt`, que é determinístico de propósito.
 *
 * Exige `batch` não vazio (o chamador já loteia chaves distintas).
 */
export function buildMetricSnapshotStatement(
  batch: readonly SkillRecord[],
  capturedAt: Date,
): Prisma.Sql {
  const keys = dedupeBySourceKey(batch).map((skill) => skill.source_key);

  return Prisma.sql`
    INSERT INTO "skill_metric_snapshot" (skill_id, captured_at, stars, installs, vulnerability_count)
    SELECT s.id, ${capturedAt}, s.stars, s.installs, s.vulnerability_count
      FROM "skill" AS s
     WHERE s.source_key IN (${Prisma.join(keys)})
       AND NOT EXISTS (
             SELECT 1
               FROM "skill_metric_snapshot" AS latest
              WHERE latest.skill_id = s.id
                AND latest.captured_at = (
                      SELECT max(previous.captured_at)
                        FROM "skill_metric_snapshot" AS previous
                       WHERE previous.skill_id = s.id
                         AND previous.captured_at < ${capturedAt}
                    )
                AND latest.stars IS NOT DISTINCT FROM s.stars
                AND latest.installs IS NOT DISTINCT FROM s.installs
                AND latest.vulnerability_count IS NOT DISTINCT FROM s.vulnerability_count
           )
    ON CONFLICT (skill_id, captured_at) DO NOTHING  `;
}

/**
 * Uma linha por `source_key`: o `Map` guarda a **última** ocorrência de cada
 * chave (a que a fonte entregou por último) na ordem da primeira aparição.
 *
 * `sourceKeyFromUrl` descarta query e fragmento, então uma página que repete a
 * skill (destaque + listagem) colapsa aqui — e é essa fusão que impede o
 * `21000` de derrubar a transação inteira.
 */
function dedupeBySourceKey(skills: readonly SkillRecord[]): SkillRecord[] {
  return [...new Map(skills.map((skill) => [skill.source_key, skill])).values()];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}
