import { HttpStatus, Module, ValidationError, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import { ERROR_CODES } from './common/errors/error-codes';
import { ApiError, HttpExceptionFilter } from './common/errors/http-exception.filter';
import { pinoHttpOptions } from './common/logging/pino-options';
import { HttpMetricsInterceptor } from './common/metrics/http-metrics.interceptor';
import { MetricsModule } from './common/metrics/metrics.module';
import { AppConfigModule, AppConfigService } from './config/config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    MetricsModule,
    HealthModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({ pinoHttp: pinoHttpOptions(config.env) }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        // Dois throttlers nomeados de §8.4 (10/min e 60/dia). O guard entra no
        // `POST /api/v1/search` na F2.6; aqui só existe a configuração.
        throttlers: [
          {
            name: 'search-minute',
            ttl: MINUTE_MS,
            limit: config.env.rateLimitSearchPerMin,
          },
          {
            name: 'search-day',
            ttl: DAY_MS,
            limit: config.env.rateLimitSearchPerDay,
          },
        ],
      }),
    }),
    // Sem `HttpModule` global: um `baseURL` único faria o adaptador do catálogo
    // herdar o do provedor LLM. Os clientes nascem na F2.3 (catálogo, com retry)
    // e na F2.5 (LLM), cada um com o seu `baseURL` nomeado.
  ],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        // §5.5: corpo inválido é 422 VALIDATION_ERROR com os campos em `details`.
        exceptionFactory: (errors: ValidationError[]) =>
          new ApiError(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ERROR_CODES.VALIDATION_ERROR,
            'Request body failed validation.',
            { fields: fieldPaths(errors) },
          ),
      }),
    },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule {}

function fieldPaths(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix.length > 0 ? `${prefix}.${error.property}` : error.property;
    const children = error.children ?? [];
    return children.length > 0 ? fieldPaths(children, path) : [path];
  });
}
