import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

// Buckets iguais aos usados até agora nos painéis: p95 de endpoint e de LLM no
// mesmo histograma.
const DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  // `labelNames` é array mutável de propósito: a tupla readonly de uma constante
  // literal não é atribuível ao `string[]` que o prom-client espera (e quebraria o
  // typecheck). A ordem dos labels é a de §9.1.
  readonly httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route, method and status.',
    labelNames: ['route', 'method', 'status'],
    registers: [this.registry],
  });

  readonly httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds.',
    labelNames: ['route', 'method'],
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  observeRequest(route: string, method: string, status: number, durationSeconds: number): void {
    this.httpRequestsTotal.inc({ route, method, status: String(status) });
    this.httpRequestDurationSeconds.observe({ route, method }, durationSeconds);
  }

  async render(): Promise<{ body: string; contentType: string }> {
    return { body: await this.registry.metrics(), contentType: this.registry.contentType };
  }
}
