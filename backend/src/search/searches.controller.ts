import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { RequestWithRequestId } from '../common/request-id.middleware';
import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import { SearchResponse } from '../contract/dto/search-response.dto';

import { SearchService } from './search.service';
import { pathValue } from './query-params';

/**
 * `GET /api/v1/searches/{request_id}` — o permalink da busca (§5.4).
 *
 * Replay, não recálculo: a ordem vem de `result_ids`, re-ranqueada pela mesma
 * função pura, e `llm.cached` sinaliza que nenhum provedor foi chamado nesta
 * leitura (D-D). Id desconhecido é 404; além de 30 dias, 410.
 *
 * O `request_id` do caminho é lido do `@Req()` e não de `@Param()`: um tipo em
 * `@Param()`/`@Query()` entra no `emitDecoratorMetadata` e o Swagger passaria a
 * descrever parâmetros que o contrato congelado já descreve com `@ApiParam`.
 */
@ApiTags('search')
@Controller('searches')
export class SearchesController {
  constructor(private readonly searchService: SearchService) {}

  @Get(':request_id')
  @ApiOperation({
    summary: 'Read a stored search',
    description: 'Same shape as the search response, with `llm.cached=true` (§5.4).',
  })
  @ApiParam({ name: 'request_id', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'The stored search.', type: SearchResponse })
  @ApiErrorResponses(404, 410, 500)
  async byRequestId(@Req() request: RequestWithRequestId): Promise<SearchResponse> {
    return this.searchService.replay(pathValue(request.params, 'request_id') ?? '');
  }
}
