/**
 * `POST /api/v1/admin/ingest` e `GET /api/v1/admin/ingest/runs` (§5.1, issue #49).
 *
 * **Por que em `/admin` e não em `/internal`:** o contrato já publica estes dois
 * paths como `x-internal` desde a F2.1, e os dez paths de `openapi.yaml` são
 * fixados por teste (`openapi-document.spec.ts`, `docs.e2e-spec.ts`). Criar
 * `/internal/ingest` inventaria um terceiro vocabulário para a mesma operação e
 * deixaria `x-internal` sem efeito. A superfície fora da API da SPA é o que
 * `x-internal` marca, não o prefixo.
 *
 * **Como a rota é isolada** (o `AdminModule` está no `AppModule`, então ela é
 * alcançável por HTTP de propósito — é uma rota de operador, não de frontend):
 *
 * - `@UseGuards(AdminTokenGuard)`: exige `X-Admin-Token`, comparado em tempo
 *   constante; sem `ADMIN_TOKEN` configurado a rota falha **fechada** (401), e
 *   em prod o `env.schema.ts` recusa o boot sem ele;
 * - `x-admin-token` não está em `allowedHeaders` do CORS de dev
 *   (`test/unit/cors.spec.ts`), então o navegador da SPA não envia o header;
 * - o header é redigido no log (`REDACT_PATHS`, `test/unit/log-redaction.spec.ts`);
 * - uma execução por vez (`IngestService`) e o índice parcial de `ingest_run`
 *   como backstop entre processos — o segundo pedido recebe `409`.
 *
 * `request_id` vem do middleware de request (o mesmo do header da resposta),
 * como nas rotas de leitura do catálogo.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

import { ApiError } from '../common/errors/http-exception.filter';
import { ERROR_CODES } from '../common/errors/error-codes';
import { newRequestId, type RequestWithRequestId } from '../common/request-id.middleware';
import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import {
  IngestOutcomeResponse,
  IngestRequest,
  IngestRun,
  IngestRunsResponse,
} from '../contract/dto/admin.dto';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../search/constants';
import { queryValue } from '../search/query-params';
import type { IngestRunOutcome } from '../catalog/ingest';
import type { IngestRunLog, IngestRunRow } from '../catalog/catalog-repository';

import { AdminTokenGuard } from './admin-token.guard';
import { INGEST_RUN_LOG } from './admin.tokens';
import { IngestService } from './ingest.service';

/** Teto de `page` (§5.6): `page=9` repetido 400 vezes viraria `Infinity` e 500. */
const MAX_PAGE = 10_000;

/** Página já validada de `GET /admin/ingest/runs`. */
interface PageParams {
  readonly page: number;
  readonly pageSize: number;
}

@ApiTags('admin')
@ApiSecurity('adminToken')
@UseGuards(AdminTokenGuard)
@Controller('admin/ingest')
export class AdminIngestController {
  constructor(
    private readonly ingestService: IngestService,
    @Inject(INGEST_RUN_LOG) private readonly runs: IngestRunLog,
  ) {}

  @Post()
  // `202` é o código de §5.1 para a operação. A execução é síncrona e limitada a
  // 20 chaves (`IngestRequest`), então o corpo já traz o **resultado** do run —
  // não um `run_id` para consultar depois.
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Refresh an explicit set of catalog keys',
    description:
      'Runs the ingestion for `source_keys` (1–20) and answers the run outcome. Requires the `X-Admin-Token` header. Answers 409 while another run is in progress (§5.1, §7.3).',
  })
  @ApiExtension('x-internal', true)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Server-side operator token.' })
  @ApiBody({ type: IngestRequest })
  @ApiResponse({
    status: 202,
    description: 'The run finished; the body is its outcome.',
    type: IngestOutcomeResponse,
  })
  @ApiErrorResponses(401, 409, 422, 500)
  async start(
    @Body() body: IngestRequest,
    @Req() request: RequestWithRequestId,
  ): Promise<IngestOutcomeResponse> {
    const attempt = await this.ingestService.refresh(body.source_keys);
    if (!attempt.started) {
      // Segunda execução: o rodízio pediria as mesmas chaves e o rate limit da
      // fonte dobraria. A resposta diz o que aconteceu, não "tente de novo".
      throw new ApiError(
        HttpStatus.CONFLICT,
        ERROR_CODES.CONFLICT,
        'An ingestion run is already in progress.',
      );
    }
    return toOutcomeResponse(requestIdOf(request), attempt.outcome);
  }

  @Get('runs')
  @ApiOperation({
    summary: 'List the latest ingestion runs',
    description: 'Requires the `X-Admin-Token` header; paginated by `page`/`page_size` (§5.6).',
  })
  @ApiExtension('x-internal', true)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Server-side operator token.' })
  @ApiQuery({
    name: 'page',
    required: false,
    schema: { type: 'integer', minimum: 1 },
    description: '1-based page.',
  })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    description: 'Items per page (1–100).',
  })
  @ApiResponse({ status: 200, description: 'A page of ingestion runs.', type: IngestRunsResponse })
  @ApiErrorResponses(401, 422, 500)
  async list(
    @Req() request: RequestWithRequestId,
  ): Promise<IngestRunsResponse> {
    const params = parsePageQuery(request.query);
    const offset = (params.page - 1) * params.pageSize;
    const [rows, total] = await Promise.all([
      this.runs.listRuns(params.pageSize, offset),
      this.runs.countRuns(),
    ]);

    return {
      request_id: requestIdOf(request),
      data: rows.map(toRun),
      pagination: {
        page: params.page,
        page_size: params.pageSize,
        total_items: total,
        total_pages: Math.ceil(total / params.pageSize),
      },
    };
  }
}

/** O `IngestRunOutcome` do domínio no formato do contrato (datas em RFC 3339). */
function toOutcomeResponse(
  requestId: string,
  outcome: IngestRunOutcome,
): IngestOutcomeResponse {
  return {
    request_id: requestId,
    status: outcome.status,
    items_requested: outcome.items_requested,
    items_seen: outcome.items_seen,
    items_upserted: outcome.items_upserted,
    items_deactivated: outcome.items_deactivated,
    error_code: outcome.error_code,
    error_detail: outcome.error_detail,
    started_at: outcome.started_at.toISOString(),
    finished_at: outcome.finished_at.toISOString(),
  };
}

/**
 * Linha de `ingest_run` -> `IngestRun` do contrato.
 *
 * `skills_ingested` é `items_upserted` (linhas de `skill` gravadas), nunca
 * `items_seen` — o §7.3 e a #46 fixaram que `items_seen` vale o tamanho do ciclo
 * e não o tamanho do catálogo.
 */
function toRun(row: IngestRunRow): IngestRun {
  return {
    run_id: String(row.id),
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at === null ? null : row.finished_at.toISOString(),
    status: row.status,
    skills_ingested: row.items_upserted ?? 0,
  };
}

/**
 * `page`/`page_size` de `GET /admin/ingest/runs`.
 *
 * Lido do `@Req()` e validado aqui — e **não** por `parseSkillListParams`: um
 * DTO de classe em `@Query()` registraria componente novo no `openapi.yaml`, e
 * reusar o parser do catálogo traria `sort_by`/`category`, que não existem na
 * listagem de runs. Os limites são os mesmos de §5.6 (1–100, default 20).
 */
function parsePageQuery(query: unknown): PageParams {
  const fields: string[] = [];
  const page = integerQuery(query, 'page', fields);
  const pageSize = integerQuery(query, 'page_size', fields);

  if (page !== undefined && (page < 1 || page > MAX_PAGE)) {
    fields.push('page');
  }
  if (pageSize !== undefined && (pageSize < 1 || pageSize > MAX_PAGE_SIZE)) {
    fields.push('page_size');
  }
  if (fields.length > 0) {
    throw new ApiError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ERROR_CODES.VALIDATION_ERROR,
      'Request query failed validation.',
      { fields: [...new Set(fields)] },
    );
  }

  return {
    page: page ?? DEFAULT_PAGE,
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
  };
}

function integerQuery(query: unknown, name: string, fields: string[]): number | undefined {
  const raw = queryValue(query, name);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    fields.push(name);
    return undefined;
  }
  return Number(raw);
}

/** Mesmo `request_id` do middleware/header, como nas rotas de leitura (§5.3). */
function requestIdOf(request: RequestWithRequestId): string {
  return request.requestId ?? newRequestId();
}
