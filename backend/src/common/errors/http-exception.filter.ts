import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { REQUEST_ID_HEADER, type RequestWithRequestId } from '../request-id.middleware';
import { codeForStatus, ERROR_CODES, type ErrorCode } from './error-codes';

export interface ErrorEnvelope {
  request_id: string | null;
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
    retry_after_seconds?: number;
  };
}

interface NormalizedError {
  status: number;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/**
 * Raised when the code is part of the contract instead of the generic mapping.
 * The filter reads `code`/`message`/`details` straight from the exception body.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    retryAfterSeconds?: number,
  ) {
    super(
      {
        code,
        message,
        details,
        ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
      },
      status,
    );
  }
}

/**
 * Chaves que o contrato de §5.5 admite em `error.details`.
 *
 * `details` chega aqui como pass-through: sem allowlist, um `catch` futuro que
 * copiasse `error.message` de um client de banco (`P1001: Can't reach database
 * server at db:5432`) publicaria host e porta no corpo, sob um 503 já
 * documentado, e ninguém veria nada anômalo.
 */
const ALLOWED_DETAIL_KEYS: readonly string[] = [
  'fields',
  'reason',
  'limit',
  'window_seconds',
  // #35: `scope` separa o 429 do orçamento global do 429 por cliente.
  'scope',
  'run_id',
  'expires_at',
];

/**
 * Único formato de erro da API (`docs/app/02-arquitetura.md` §5.5):
 * `{request_id, error: {code, message, details}}`. Stack trace vai para o log,
 * nunca para a resposta.
 */
/**
 * `HttpStatus` é um enum; comparar `number` com membro de enum é o que a regra
 * `no-unsafe-enum-comparison` reprova. A constante nomeada diz o que o número
 * significa e mantém a comparação entre dois `number`.
 */
const SERVER_ERROR_FLOOR: number = HttpStatus.INTERNAL_SERVER_ERROR;

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithRequestId>();
    const response = context.getResponse<Response>();
    const normalized = normalize(exception);
    const requestId = request.requestId ?? headerAsString(response.getHeader(REQUEST_ID_HEADER));

    if (normalized.status >= SERVER_ERROR_FLOOR) {
      this.logger.error(
        `${normalized.code} on ${request.method} ${request.originalUrl ?? request.url}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    // `Retry-After` acompanha `retry_after_seconds` em **todo** 429: o corpo é o
    // contrato, mas o header é o que um `curl`/cliente HTTP genérico respeita, e
    // um 429 sem ele (o do orçamento global, #35) convidaria a repetir na hora.
    if (normalized.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', normalized.retryAfterSeconds);
    }

    const envelope: ErrorEnvelope = {
      request_id: requestId,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: this.contractDetails(normalized.details),
        ...(normalized.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: normalized.retryAfterSeconds }),
      },
    };

    response.status(normalized.status).json(envelope);
  }

  /**
   * Publica só as chaves do catálogo fechado de §5.5, em **todo** status — 4xx
   * incluído, porque é a classe mais alcançável por um cliente e um `catch` de
   * driver embrulhado num 409 publicaria host, porta e nome de constraint.
   * Objeto vazio continua objeto (o schema exige a chave) e o descarte vai para o
   * log **sem o valor**, porque é justamente o valor que pode carregar o segredo.
   */
  private contractDetails(details: Record<string, unknown>): Record<string, unknown> {
    const allowed: Record<string, unknown> = {};
    const dropped: string[] = [];

    for (const [key, value] of Object.entries(details)) {
      if (ALLOWED_DETAIL_KEYS.includes(key)) {
        allowed[key] = value;
      } else {
        dropped.push(key);
      }
    }

    if (dropped.length > 0) {
      this.logger.warn(`dropped non-contract error detail keys: ${dropped.join(', ')}`);
    }

    return allowed;
  }
}

function normalize(exception: unknown): NormalizedError {
  if (!(exception instanceof HttpException)) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL,
      message: 'Internal server error.',
      details: {},
    };
  }

  const status = exception.getStatus();
  const body = exception.getResponse();

  if (typeof body === 'string') {
    return { status, code: codeForStatus(status), message: body, details: {} };
  }

  const record = body as Record<string, unknown>;
  const code = isErrorCode(record.code) ? record.code : codeForStatus(status);
  const details: Record<string, unknown> = isPlainObject(record.details)
    ? record.details
    : messageListToFields(record.message);
  const retryAfterSeconds =
    typeof record.retry_after_seconds === 'number' ? record.retry_after_seconds : undefined;

  return {
    status,
    code,
    message: messageText(record.message, status),
    details,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

// `ValidationPipe` padrão devolve `message: string[]`; o contrato quer detalhes
// nomeados, então a lista vira `details.fields`.
function messageListToFields(message: unknown): Record<string, unknown> {
  if (!Array.isArray(message) || message.length === 0) {
    return {};
  }
  return { fields: message.filter((item): item is string => typeof item === 'string') };
}

function messageText(message: unknown, status: number): string {
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  if (Array.isArray(message) && message.length > 0) {
    return 'Request body failed validation.';
  }
  return status >= SERVER_ERROR_FLOOR ? 'Internal server error.' : 'Request failed.';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.values(ERROR_CODES).includes(value as ErrorCode);
}

function headerAsString(value: number | string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value === undefined ? null : String(value);
}
