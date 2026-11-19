import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
} from 'class-validator';

import { Pagination } from './catalog.dto';

/**
 * Contrato dos dois endpoints de administração (§5.1, #49).
 *
 * Eles exigem `X-Admin-Token` (segredo de servidor, nunca no bundle) e são
 * `x-internal`: não fazem parte da API da SPA. O runtime que os serve é o
 * `AdminModule` (`backend/src/admin/`), montado no `AppModule` desde a #49 — até
 * lá o controller vivia em `contract-admin.controller.ts`, importado só pelo
 * gerador do OpenAPI, e a rota respondia 404.
 */

/** `IngestStatus` do `schema.prisma` — os quatro valores que a coluna aceita. */
export const INGEST_STATUSES = ['running', 'ok', 'partial', 'failed'] as const;

export type IngestStatus = (typeof INGEST_STATUSES)[number];

/**
 * Os três estados de um run **fechado** — o que `POST /admin/ingest` devolve.
 * `running` só aparece no histórico (`IngestRun`): a resposta chega depois do
 * `finishRun`, então o run que ela descreve nunca está em andamento.
 */
export const INGEST_OUTCOME_STATUSES = ['ok', 'partial', 'failed'] as const;

/** Teto de chaves por refresh sob demanda (`source_keys`). */
export const MAX_SOURCE_KEYS = 20;

/**
 * Corpo de `POST /api/v1/admin/ingest` (#49).
 *
 * `source_keys` é o **refresh sob demanda**: o operador dá até 20 `source_key`
 * e o run pede exatamente essas à fonte, sem girar o rodízio nem gastar a cota
 * de descoberta. O teto de 20 mantém o request curto a 1 req/s (~20 s) e é
 * validado aqui — 21 chaves são `422 VALIDATION_ERROR`, nunca um run maior.
 */
export class IngestRequest {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_SOURCE_KEYS,
    example: ['acme/toolbox/find-skills'],
    description:
      'Source keys to refresh (1–20). Each one is `owner/repo/slug`; a key the source no longer publishes is omitted, not an error.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SOURCE_KEYS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  source_keys!: string[];
}

/**
 * `POST /api/v1/admin/ingest` → `202` (#49).
 *
 * O corpo é o `IngestRunOutcome` de `backend/src/catalog/ingest.ts`: os
 * contadores do run que **acabou** de rodar. `items_seen` é o tamanho do ciclo
 * pedido (aqui, no máximo 20) e **nunca** o total de skills do catálogo — quem
 * responde por isso é `countActiveSkills`, não `ingest_run`.
 */
export class IngestOutcomeResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({
    enum: [...INGEST_OUTCOME_STATUSES],
    example: 'ok',
    description:
      'Run state: `ok` ingested the whole cycle, `partial` kept part of it out (see `error_code`), `failed` wrote nothing.',
  })
  status!: (typeof INGEST_OUTCOME_STATUSES)[number];

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Keys the run asked the source for — the cycle size, not the catalog size.',
  })
  items_requested!: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Distinct keys the source returned.' })
  items_seen!: number;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Distinct skill rows written.' })
  items_upserted!: number;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'Rows deactivated by the 28-day TTL during this run.',
  })
  items_deactivated!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Stable code when the run was not `ok` (`SOURCE_FETCH_FAILED`, `REPOSITORY_FAILED`, `EMPTY_CATALOG`, `LOW_CYCLE_COVERAGE`, `LOW_UPSERT_RATIO`).',
  })
  error_code!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Short diagnostic detail, no secrets.' })
  error_detail!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'RFC 3339 UTC.' })
  started_at!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'RFC 3339 UTC.' })
  finished_at!: string;
}

export class IngestRun {
  @ApiProperty({ type: String, description: 'Run identifier.' })
  run_id!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'RFC 3339 UTC.' })
  started_at!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'null while the run is still in progress.',
  })
  finished_at!: string | null;

  @ApiProperty({
    enum: [...INGEST_STATUSES],
    example: 'running',
    description:
      'Run state. `ok` ingested everything, `partial` kept some skills out and `failed` wrote nothing.',
  })
  status!: IngestStatus;

  @ApiProperty({ type: 'integer', minimum: 0, description: 'Skills written by this run.' })
  skills_ingested!: number;
}

/** `GET /api/v1/admin/ingest/runs` → `200` (§5.1 e §5.6). */
export class IngestRunsResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({ type: [IngestRun], description: 'Most recent runs first.' })
  data!: IngestRun[];

  @ApiProperty({ type: () => Pagination })
  pagination!: Pagination;
}
