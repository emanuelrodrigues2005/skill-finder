import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import { SearchRequest } from '../contract/dto/search-request.dto';
import { SearchResponse } from '../contract/dto/search-response.dto';
import type { RequestWithRequestId } from '../common/request-id.middleware';

import { DEFAULT_SEARCH_LIMIT } from './constants';
import { queryValue } from './query-params';
import { stampSearchRequestId } from './request-id';
import { resolveClientIp } from './client-hash';
import { SearchService } from './search.service';
import { SearchThrottlerGuard } from './search-throttler.guard';

/**
 * `POST /api/v1/search` (§5.2–§5.3).
 *
 * O corpo é validado pelo `ValidationPipe` global contra o DTO congelado (3–500
 * caracteres, `limit` 1–20, campo desconhecido é 422 — nunca ignorado).
 *
 * O `request_id` da resposta é o que o **serviço** cunhou: o header
 * `X-Request-ID` recebido é opaco e não vira chave do histórico (C4). Por isso o
 * header da resposta é reescrito com o id do corpo — cliente e servidor precisam
 * citar o mesmo valor.
 */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Post()
  // D1 (#13): o rate limit vive **nesta rota**, não em `APP_GUARD` — um guard
  // global contaria `/healthz`, `/readyz` e `/metrics`, e um probe limitado
  // reinicia o container em loop. O guard roda antes do handler: busca barrada
  // não persiste no histórico.
  @UseGuards(SearchThrottlerGuard)
  // `POST` responde 200 no contrato (§5.1), não o 201 que o Nest dá por padrão:
  // a busca não cria um recurso endereçável pela URI chamada.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search the catalog with a natural-language query',
    description:
      'Interprets the intent, retrieves candidates, ranks them deterministically and explains the top matches (§5.2, §5.3, §6).',
  })
  @ApiBody({ type: SearchRequest })
  @ApiQuery({
    name: 'strict_llm',
    required: false,
    schema: { type: 'boolean' },
    description:
      'Opt in to failing instead of degrading when the provider answers invalid: only with this flag can the call end in 502.',
  })
  @ApiResponse({
    status: 200,
    description: 'Ranked results, at most `limit` items.',
    type: SearchResponse,
  })
  @ApiErrorResponses(400, 422, 429, 500, 502, 503)
  async search(
    @Body() body: SearchRequest,
    @Req() request: RequestWithRequestId,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SearchResponse> {
    const result = await this.searchService.search({
      query: body.query,
      category: body.category ?? null,
      limit: body.limit ?? DEFAULT_SEARCH_LIMIT,
      strictLlm: queryValue(request.query, 'strict_llm') === 'true',
      clientIp: resolveClientIp(request),
      // O header entra só como rastro: a chave do histórico é cunhada adiante.
      requestId: request.requestId ?? '',
    });

    stampSearchRequestId(response, result.request_id);
    return result;
  }
}
