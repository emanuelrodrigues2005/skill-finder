import { Controller, Get, HttpStatus, Logger } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { PostgresHealthIndicator } from './postgres-health.indicator';

@ApiTags('health')
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
  ) {}

  @Get('healthz')
  @HealthCheck()
  @ApiOperation({ summary: 'Liveness probe (no dependencies)' })
  liveness(): ReturnType<HealthCheckService['check']> {
    return this.health.check([]);
  }

  @Get('readyz')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (Postgres answering)' })
  async readiness(): ReturnType<HealthCheckService['check']> {
    try {
      return await this.health.check([() => this.postgres.check('postgres')]);
    } catch (error) {
      // Qualquer falha de dependência vira o envelope de §5.5, não o formato do terminus.
      this.logger.warn(
        `readiness failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        ERROR_CODES.NOT_READY,
        'Database is not reachable.',
        { dependency: 'postgres' },
      );
    }
  }
}
