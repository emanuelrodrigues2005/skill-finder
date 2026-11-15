import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';

import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  @ApiExcludeEndpoint()
  @Header('Cache-Control', 'no-store')
  async render(@Res() response: Response): Promise<void> {
    const { body, contentType } = await this.metricsService.render();
    response.type(contentType).send(body);
  }
}
