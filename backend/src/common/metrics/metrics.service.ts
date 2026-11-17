import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

// Import relativo (e não pelo alias `@/`): este módulo é carregado pelo
// `ts-node` de `pnpm openapi:generate`, que resolve caminhos do Node — um alias
// só existe no `paths` do `tsc`/`moduleNameMapper` do Jest.
import { LLM_STATUSES, type LlmStatus } from '../../contract/dto/search-response.dto';

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

  /**
   * `llm_calls_total{status}` (§9.1).
   *
   * O `status` é o do contrato (`LLM_STATUSES`), não um rótulo novo: um painel
   * que agrupe por ele continua válido quando o passo de LLM muda de provedor.
   * As sete séries nascem em zero no boot para o `/metrics` mostrar a tabela
   * inteira — uma série que só aparece depois do primeiro erro esconde justamente
   * o caminho que nunca aconteceu.
   */
  readonly llmCallsTotal = new Counter({
    name: 'llm_calls_total',
    help: 'LLM intent calls by contract status.',
    labelNames: ['status'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    for (const status of LLM_STATUSES) {
      this.llmCallsTotal.inc({ status }, 0);
    }
  }

  observeRequest(route: string, method: string, status: number, durationSeconds: number): void {
    this.httpRequestsTotal.inc({ route, method, status: String(status) });
    this.httpRequestDurationSeconds.observe({ route, method }, durationSeconds);
  }

  /** Conta uma chamada ao passo de intenção pelo desfecho de §5.3 (D-F). */
  observeLlmCall(status: LlmStatus): void {
    this.llmCallsTotal.inc({ status });
  }

  async render(): Promise<{ body: string; contentType: string }> {
    return { body: await this.registry.metrics(), contentType: this.registry.contentType };
  }
}
