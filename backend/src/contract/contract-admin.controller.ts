import { Controller, Get, Post } from '@nestjs/common';
import {
  ApiExtension,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrorResponses } from './api-error-responses.decorator';
import { contractOnly } from './contract-only';
import { IngestRunsResponse, IngestStartedResponse } from './dto/admin.dto';

/**
 * Os dois endpoints de administração de §5.1, marcados `x-internal: true`.
 *
 * Eles não têm serviço por trás: o handler só falha (`contractOnly`) e o runtime
 * que os serve é a F2.3, com `X-Admin-Token`. Ficam num módulo separado do
 * contrato público justamente para deixar claro que não são API de frontend.
 *
 * O header aparece duas vezes de propósito: `securitySchemes` (via
 * `@ApiSecurity`) só é lido por gerador de cliente, enquanto `@ApiHeader` é o
 * que o consumidor vê na operação. Sem os dois, o token fica só em prosa.
 *
 * Nota de implementação: este módulo entra no documento pelo
 * `OpenApiDocumentModule`, importado só pelo gerador — o `SwaggerModule` varre os
 * controllers da app compilada (`swagger-scanner.js` → `container.getModules()`),
 * então o grafo do gerador precisa contê-los. O runtime não os monta.
 */
@ApiTags('admin')
@ApiSecurity('adminToken')
@Controller('admin/ingest')
export class AdminIngestController {
  @Post()
  @ApiOperation({
    summary: 'Trigger a manual catalog ingestion',
    description:
      'Requires the `X-Admin-Token` header. Answers 409 while another run is in progress (§5.1).',
  })
  @ApiExtension('x-internal', true)
  @ApiHeader({ name: 'X-Admin-Token', required: true, description: 'Server-side operator token.' })
  @ApiResponse({ status: 202, description: 'Ingestion accepted.', type: IngestStartedResponse })
  @ApiErrorResponses(401, 409, 500)
  start(): never {
    return contractOnly();
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
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    description: 'Items per page (1–100).',
  })
  @ApiResponse({ status: 200, description: 'A page of ingestion runs.', type: IngestRunsResponse })
  @ApiErrorResponses(401, 500)
  runs(): never {
    return contractOnly();
  }
}
