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
 * Único formato de erro da API (`docs/app/02-arquitetura.md` §5.5):
 * `{request_id, error: {code, message, details}}`. Stack trace vai para o log,
 * nunca para a resposta.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithRequestId>();
    const response = context.getResponse<Response>();
    const normalized = normalize(exception);
    const requestId = request.requestId ?? headerAsString(response.getHeader(REQUEST_ID_HEADER));

    if (normalized.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${normalized.code} on ${request.method} ${request.originalUrl ?? request.url}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const envelope: ErrorEnvelope = {
      request_id: requestId,
      error: {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
        ...(normalized.retryAfterSeconds === undefined
          ? {}
          : { retry_after_seconds: normalized.retryAfterSeconds }),
      },
    };

    response.status(normalized.status).json(envelope);
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
  return status >= HttpStatus.INTERNAL_SERVER_ERROR
    ? 'Internal server error.'
    : 'Request failed.';
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
