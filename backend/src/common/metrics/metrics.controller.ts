import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExtension, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { ApiErrorResponses } from '../../contract/api-error-responses.decorator';
import { MetricsService } from './metrics.service';

@ApiTags('metrics')
@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Fora do `/api/v1` (`PUBLIC_ROUTES` do `main.ts`) e em `text/plain`: é o
   * formato de exposition do Prometheus, não JSON — por isso a resposta é
   * descrita com `content['text/plain']` em vez de um schema de sucesso JSON.
   */
  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus metrics (application + HTTP instrumentation)' })
  @ApiExtension('x-internal', true)
  @ApiResponse({
    status: 200,
    description: 'Prometheus text exposition format.',
    content: { 'text/plain': { schema: { type: 'string' } } },
  })
  @ApiErrorResponses(500)
  @Header('Cache-Control', 'no-store')
  async render(@Res() response: Response): Promise<void> {
    const { body, contentType } = await this.metricsService.render();
    response.type(contentType).send(body);
  }
}
