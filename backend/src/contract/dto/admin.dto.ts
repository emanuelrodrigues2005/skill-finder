import { ApiProperty } from '@nestjs/swagger';

import { Pagination } from './catalog.dto';

/**
 * Contrato dos dois endpoints de administração (§5.1).
 *
 * Eles exigem `X-Admin-Token` (segredo de servidor, nunca no bundle) e existem
 * aqui apenas para congelar o documento: quem os serve é a F2.3. Por isso são
 * `x-internal` e moram em `ContractAdminModule`, separado do contrato público.
 */

/** `IngestStatus` do `schema.prisma` — os quatro valores que a coluna aceita. */
export const INGEST_STATUSES = ['running', 'ok', 'partial', 'failed'] as const;

export type IngestStatus = (typeof INGEST_STATUSES)[number];

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

/** `POST /api/v1/admin/ingest` → `202` (§5.1). */
export class IngestStartedResponse {
  @ApiProperty({ type: String, description: 'Request id echo (`X-Request-Id`).' })
  request_id!: string;

  @ApiProperty({ type: String, description: 'Id of the run that was accepted.' })
  run_id!: string;

  @ApiProperty({
    enum: [...INGEST_STATUSES],
    example: 'running',
    description: 'State of the new run.',
  })
  status!: IngestStatus;
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
