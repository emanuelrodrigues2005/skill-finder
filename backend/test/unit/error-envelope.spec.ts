import type { ArgumentsHost } from '@nestjs/common';
import { HttpStatus, Logger } from '@nestjs/common';

import { ERROR_CODES, type ErrorCode } from '@/common/errors/error-codes';
import {
  ApiError,
  HttpExceptionFilter,
  type ErrorEnvelope,
} from '@/common/errors/http-exception.filter';

/**
 * Gate da allowlist de `details` no envelope de erro (§5.5).
 *
 * `details` é o único campo do envelope que carrega contexto livre, e é por onde
 * texto de terceiro (stack trace, SQL do Postgres, resposta crua do provedor de
 * LLM) entra na resposta se ninguém filtrar. A decisão do `security`: só o
 * catálogo fechado de §5.5 atravessa — `fields`, `reason`, `limit`,
 * `window_seconds`, `run_id` e `expires_at`; o resto é descartado pelo filtro (e
 * logado em `warn` por ele — o log não é objeto deste teste).
 *
 * A filtragem vale em **todo status**, inclusive 4xx: é a classe mais alcançável
 * por um cliente, e um `catch` que embrulhasse erro de driver num 409 publicaria
 * host, porta e nome de constraint sob um código já documentado. O custo é que
 * chave autoral nova precisa entrar no catálogo (e na descrição do DTO) — os dois
 * últimos casos existem para isso não passar despercebido.
 *
 * Unitário de propósito: sem módulo Nest, só o filtro e dois dublês. O caminho
 * HTTP de verdade (500 atravessando o filtro) já é coberto por
 * `health.e2e-spec.ts`; aqui o alvo é a allowlist, não o transporte.
 */
interface RecordedResponse {
  statusCode: number | undefined;
  body: ErrorEnvelope | undefined;
  getHeader(name: string): string | undefined;
  status(code: number): RecordedResponse;
  json(body: ErrorEnvelope): RecordedResponse;
}

/** Roda o filtro com um `ApiError` e devolve o que foi escrito no response. */
function writeEnvelope(
  details: Record<string, unknown>,
  status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
  code: ErrorCode = ERROR_CODES.INTERNAL,
  message = 'Internal server error.',
): RecordedResponse {
  const response: RecordedResponse = {
    statusCode: undefined,
    body: undefined,
    getHeader: (_name: string): string | undefined => undefined,
    status(code: number): RecordedResponse {
      this.statusCode = code;
      return this;
    },
    json(body: ErrorEnvelope): RecordedResponse {
      this.body = body;
      return this;
    },
  };

  // `ArgumentsHost` mínimo: o filtro lê `request.requestId`, `request.method`,
  // `request.originalUrl` e escreve com `response.status().json()`.
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({
        requestId: 'req_TEST',
        method: 'POST',
        originalUrl: '/api/v1/search',
      }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  const error = new ApiError(status, code, message, details);

  new HttpExceptionFilter().catch(error, host);
  return response;
}

describe('error envelope details allowlist (§5.5)', () => {
  beforeEach(() => {
    // O filtro loga todo 500 em `error`; stack no log é esperado, o que se testa
    // aqui é que ela não chegue no corpo.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps only the allowlisted detail keys', () => {
    const response = writeEnvelope({
      fields: ['query', 'limit'],
      reason: 'db_unavailable',
      limit: 10,
      window_seconds: 60,
      stack: 'Error: boom\n    at Postgres.connect (/app/src/prisma/prisma.service.ts:31:7)',
      sql: 'SELECT id FROM search_history WHERE client_hash = $1',
    });

    expect(response.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.body?.request_id).toBe('req_TEST');
    expect(response.body?.error.code).toBe(ERROR_CODES.INTERNAL);
    expect(response.body?.error.details).toEqual({
      fields: ['query', 'limit'],
      reason: 'db_unavailable',
      limit: 10,
      window_seconds: 60,
    });

    // Não basta não estar em `details.<chave>`: o texto não pode aparecer em
    // lugar nenhum do corpo (inclusive `message` e `retry_after_seconds`).
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('Postgres.connect');
    expect(serialized).not.toContain('SELECT id FROM search_history');

    // `details` continua sendo objeto: a chave não pode ser removida.
    expect(Object.keys(response.body?.error ?? {}).sort()).toEqual(['code', 'details', 'message']);
  });

  it('keeps details as an object when every key is dropped', () => {
    const response = writeEnvelope({
      stack: 'Error: boom\n    at Postgres.connect (/app/src/prisma/prisma.service.ts:31:7)',
      sql: 'SELECT id FROM search_history WHERE client_hash = $1',
    });

    expect(response.body?.error.details).toEqual({});
    expect(Array.isArray(response.body?.error.details)).toBe(false);
    expect(Object.keys(response.body?.error ?? {}).sort()).toEqual(['code', 'details', 'message']);
  });

  it('keeps the authorial run id and reason from a 409', () => {
    const response = writeEnvelope(
      { run_id: 'run_01JCV8Y6Q4MBQ1X625SECV7Y3', reason: 'run_in_progress' },
      HttpStatus.CONFLICT,
      ERROR_CODES.CONFLICT,
      'An ingestion run is already in progress.',
    );

    expect(response.statusCode).toBe(HttpStatus.CONFLICT);
    expect(response.body?.error.code).toBe(ERROR_CODES.CONFLICT);
    // `run_id` e `reason` são contexto autoral do 409 e estão no catálogo fechado,
    // então sobrevivem à filtragem que vale em todo status.
    expect(response.body?.error.details).toEqual({
      run_id: 'run_01JCV8Y6Q4MBQ1X625SECV7Y3',
      reason: 'run_in_progress',
    });
  });

  it('drops an unexpected stack from a 4xx but keeps the authorial run id', () => {
    const stack = 'Error: boom\n    at Postgres.connect (/app/src/prisma/prisma.service.ts:31:7)';
    const response = writeEnvelope(
      { run_id: 'run_01JCV8Y6Q4MBQ1X625SECV7Y3', stack },
      HttpStatus.CONFLICT,
      ERROR_CODES.CONFLICT,
      'An ingestion run is already in progress.',
    );

    // A allowlist vale em TODO status: 4xx é a classe mais alcançável por
    // atacante, e um catch que embrulhe erro de driver em 409 publicaria host,
    // porta e nome de constraint. `run_id` sobrevive porque está na lista.
    expect(response.body?.error.details).toEqual({
      run_id: 'run_01JCV8Y6Q4MBQ1X625SECV7Y3',
    });
    expect(JSON.stringify(response.body)).not.toContain('Postgres.connect');
  });
});
