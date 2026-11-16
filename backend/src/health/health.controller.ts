import { Controller, Get, Header, HttpStatus, Logger } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiExtension, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { ApiErrorResponses } from '../contract/api-error-responses.decorator';
import { HealthResponse } from '../contract/dto/health.dto';
import { PostgresHealthIndicator } from './postgres-health.indicator';

@ApiTags('health')
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
  ) {}

  /**
   * Liveness sem `@HealthCheck()`: aquele decorator documenta 503 no endpoint,
   * e `/healthz` não depende de nada — §5.1 só admite 200 e 500 aqui. O
   * `Cache-Control` que ele também aplicava continua explícito.
   */
  @Get('healthz')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  @ApiOperation({
    summary: 'Liveness probe (no dependencies)',
    description:
      'Process liveness only: answers 200 while the event loop runs. No dependency is ' +
      'touched, so a database outage never restarts the container. Lives outside ' +
      '`/api/v1` (`PUBLIC_ROUTES`), like the other two internal endpoints.',
  })
  @ApiExtension('x-internal', true)
  @ApiResponse({ status: 200, description: 'The process is alive.', type: HealthResponse })
  @ApiErrorResponses(500)
  liveness(): ReturnType<HealthCheckService['check']> {
    return this.health.check([]);
  }

  /**
   * Readiness documenta 200/500/503 (§5.1).
   *
   * `@HealthCheck({ swaggerDocumentation: false })`: o decorator do terminus
   * registra 200 e 503 próprios, e o `ApiResponse` faz merge das entradas por
   * status — o `schema` dele sobrevivia ao meu `content` (o `ResponseObjectFactory`
   * prefere `schema`), e o 503 saía sem o envelope de §5.5. Desligada a parte
   * Swagger, fica só o `Cache-Control` que ele também aplica, e as três respostas
   * daqui são as únicas documentadas.
   */
  @Get('readyz')
  @ApiOperation({
    summary: 'Readiness probe (Postgres answering)',
    description:
      'Answers 200 only when every dependency answers. A Postgres that does not answer ' +
      'becomes `503 NOT_READY` in the §5.5 envelope, with `details.reason = ' +
      '"db_unavailable"` — never a 200 with stale data.',
  })
  @ApiExtension('x-internal', true)
  @ApiResponse({ status: 200, description: 'Every dependency answered.', type: HealthResponse })
  @ApiErrorResponses(500, {
    status: 503,
    code: ERROR_CODES.NOT_READY,
    description: 'Postgres did not answer: `NOT_READY` in the §5.5 envelope.',
  })
  @HealthCheck({ swaggerDocumentation: false, noCache: true })
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
        { reason: 'db_unavailable' },
      );
    }
  }
}
