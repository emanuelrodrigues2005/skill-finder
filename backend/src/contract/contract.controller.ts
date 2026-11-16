import { Controller, Get, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ApiErrorResponses } from './api-error-responses.decorator';
import { contractOnly } from './contract-only';
import { CategoryListResponse, SkillDetailResponse, SkillListResponse } from './dto/catalog.dto';
import { SearchRequest } from './dto/search-request.dto';
import { SearchResponse } from './dto/search-response.dto';

const SORT_FIELDS = ['installs', 'stars', 'name'] as const;

/**
 * Os cinco endpoints públicos de §5.1, declarados para o `openapi.yaml` v0.
 *
 * Cada handler falha de propósito (`contractOnly`): o serviço por trás chega nas
 * F2.3–F2.6, e o runtime só monta estas rotas quando isso acontecer — hoje elas
 * entram no documento pelo `OpenApiDocumentModule`, importado apenas pelo
 * gerador. Sem `@Body`/`@Query`/`@Param` de runtime de propósito — quem descreve
 * entrada aqui são `@ApiBody`/`@ApiQuery`/`@ApiParam`, e o pipe global não deve
 * julgar um corpo que ninguém ainda lê. O que está congelado é o contrato: path,
 * status, schema e parâmetros, que é o que o frontend consome em paralelo.
 */
@ApiTags('search')
@Controller('search')
export class SearchController {
  @Post()
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
  search(): never {
    return contractOnly();
  }
}

@ApiTags('search')
@Controller('searches')
export class SearchesController {
  @Get(':request_id')
  @ApiOperation({
    summary: 'Read a stored search',
    description: 'Same shape as the search response, with `llm.cached=true` (§5.4).',
  })
  @ApiParam({ name: 'request_id', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'The stored search.', type: SearchResponse })
  @ApiErrorResponses(404, 410, 500)
  byRequestId(): never {
    return contractOnly();
  }
}

@ApiTags('catalog')
@Controller('categories')
export class CategoriesController {
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
  list(): never {
    return contractOnly();
  }
}

@ApiTags('catalog')
@Controller('skills')
export class SkillsController {
  @Get()
  @ApiOperation({
    summary: 'Browse the catalog with filters and pagination',
    description:
      'Deterministic ordering by `sort_by`; `page`/`page_size` have hard ceilings (§5.6).',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    schema: { type: 'string' },
    description: 'Category slug filter.',
  })
  @ApiQuery({
    name: 'sort_by',
    required: false,
    schema: { type: 'string', enum: [...SORT_FIELDS], default: 'installs' },
    description: 'Ordering key. Only these three fields; there is no free-form sort.',
  })
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
  @ApiResponse({ status: 200, description: 'A page of skills.', type: SkillListResponse })
  @ApiErrorResponses(400, 422, 500)
  list(): never {
    return contractOnly();
  }

  @Get(':skill_id')
  @ApiOperation({
    summary: 'Read one skill, including the SKILL.md excerpt',
    description: 'Detail view of the catalog row (§5.4).',
  })
  @ApiParam({ name: 'skill_id', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'The skill.', type: SkillDetailResponse })
  @ApiErrorResponses(404, 500)
  detail(): never {
    return contractOnly();
  }
}
