import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';

import { MetricsService } from './metrics.service';

interface RoutedRequest extends Request {
  route?: { path?: string };
  baseUrl?: string;
}

/**
 * Templates que não entram na medição: o `/metrics` conta a si mesmo a cada
 * scrape e o `/healthz` é chamado pelo healthcheck do compose/orquestrador —
 * os dois em loop, e sem essa exclusão o `http_requests_total` mediria o
 * monitoramento, não o tráfego. `/readyz` segue medido (é prova de vida da
 * instrumentação até existir rota de domínio na F2.6).
 */
export const UNMETERED_ROUTE_TEMPLATES: readonly string[] = ['/healthz', '/metrics'];

/**
 * Registra `http_requests_total{route,method,status}` e
 * `http_request_duration_seconds{route,method}` (`docs/app/02-arquitetura.md` §9.1).
 *
 * O label `route` é o template (`/skills/:skill_id`), nunca a URL concreta: um id
 * no label explodiria a cardinalidade do Prometheus.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor<unknown, unknown> {
  constructor(private readonly metricsService: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RoutedRequest>();
    const response = http.getResponse<Response>();
    const route = routeTemplate(request);

    if (UNMETERED_ROUTE_TEMPLATES.includes(route)) {
      return next.handle();
    }

    const method = request.method;
    const startedAt = process.hrtime.bigint();

    const record = (status: number): void => {
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      this.metricsService.observeRequest(route, method, status, durationSeconds);
    };

    return next.handle().pipe(
      tap({
        next: () => record(response.statusCode),
        error: (error: unknown) => record(statusOf(error)),
      }),
    );
  }
}

function routeTemplate(request: RoutedRequest): string {
  const path = request.route?.path;
  if (!path) {
    return 'unmatched';
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${request.baseUrl ?? ''}${normalized}`;
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
}
