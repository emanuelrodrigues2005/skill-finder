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
} from './catalog-repository';
import type { SkillRecord } from './skill-source';

/**
 * Linhas por statement: `search_doc` acrescenta parâmetros e o teto do Postgres
 * é de 65 535 por query. 500 linhas deixam folga larga.
 */
const UPSERT_CHUNK_SIZE = 500;

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

  async startRun(run: { adapter: string; started_at: Date }): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO "ingest_run" (adapter, started_at, status)
      VALUES (${run.adapter}, ${run.started_at}, 'running'::"IngestStatus")
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

  async deactivateSkillsNotSeenSince(seenAt: Date): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "skill"
         SET is_active = false
       WHERE is_active = true
         AND last_seen_at < ${seenAt}
    `;
  }
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
