import { Controller, Get, HttpStatus, Req } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import type { RequestWithRequestId } from '../common/request-id.middleware';
import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import { SkillDetailResponse, SkillListResponse } from '../contract/dto/catalog.dto';

import { SKILL_SORT_FIELDS } from './constants';
import { decodeSkillId } from './ids';
import { parseSkillListParams, pathValue } from './query-params';
import { requestIdOf } from './request-id';
import { SearchService } from './search.service';

/**
 * `GET /api/v1/skills` e `GET /api/v1/skills/{skill_id}` (§5.4, §5.6).
 *
 * Os parâmetros são lidos do `@Req()` e validados em `parseSkillListParams`: um
 * DTO tipado em `@Query()` registraria um componente novo no `openapi.yaml`, que
 * está congelado. `sort_by` é um enum fechado (installs/stars/name); não existe
 * ordenação por texto livre.
 *
 * O `skill_id` público (`sk_...`, D-B) é decodificado aqui: id malformado e id
 * inexistente respondem o mesmo 404, nunca 500.
 */
@ApiTags('catalog')
@Controller('skills')
export class SkillsController {
  constructor(private readonly searchService: SearchService) {}

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
    schema: { type: 'string', enum: [...SKILL_SORT_FIELDS], default: 'installs' },
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
  async list(@Req() request: RequestWithRequestId): Promise<SkillListResponse> {
    const params = parseSkillListParams(request.query);
    const page = await this.searchService.skills({
      category: params.category,
      sortBy: params.sortBy,
      page: params.page,
      pageSize: params.pageSize,
    });

    return {
      request_id: requestIdOf(request),
      data: [...page.items],
      pagination: {
        page: params.page,
        page_size: params.pageSize,
        total_items: page.total_items,
        total_pages: Math.ceil(page.total_items / params.pageSize),
      },
    };
  }

  @Get(':skill_id')
  @ApiOperation({
    summary: 'Read one skill, including the SKILL.md excerpt',
    description: 'Detail view of the catalog row (§5.4).',
  })
  @ApiParam({ name: 'skill_id', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'The skill.', type: SkillDetailResponse })
  @ApiErrorResponses(404, 500)
  async detail(@Req() request: RequestWithRequestId): Promise<SkillDetailResponse> {
    const skillId = decodeSkillId(pathValue(request.params, 'skill_id') ?? '');
    if (skillId === null) {
      // O mesmo 404 de um id que não existe: qualificar o erro aqui contaria ao
      // cliente se o id é bem formado, e o contrato não promete isso.
      throw new ApiError(HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND, 'Skill not found.');
    }
    return { request_id: requestIdOf(request), data: await this.searchService.skillDetail(skillId) };
  }
}
