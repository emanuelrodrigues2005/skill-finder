import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import type { RequestWithRequestId } from '../common/request-id.middleware';
import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import { CategoryListResponse } from '../contract/dto/catalog.dto';

import { requestIdOf } from './request-id';
import { SearchService } from './search.service';

/**
 * `GET /api/v1/categories` (§5.4).
 *
 * É o **único** payload do contrato com `data_snapshot`: a tela de busca mostra
 * "catálogo de <data>" a partir daqui. `pagination` não existe nesta rota (o
 * contrato não a declara) — `GET /api/v1/skills` é quem pagina.
 */
@ApiTags('catalog')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'List the categories for the UI selector',
    description: 'Slugs, English labels and skill counts of the current snapshot (§5.4).',
  })
  @ApiResponse({
    status: 200,
    description: 'Every category of the catalog.',
    type: CategoryListResponse,
  })
  @ApiErrorResponses(500, 503)
  async list(@Req() request: RequestWithRequestId): Promise<CategoryListResponse> {
    const { data, data_snapshot } = await this.searchService.categories();
    return { request_id: requestIdOf(request), data: [...data], data_snapshot };
  }
}
