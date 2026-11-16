import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

import { codeForStatus, type ErrorCode } from '../common/errors/error-codes';
import { ErrorEnvelope } from './dto/error-envelope.dto';

/** Descrição de cada status de erro da tabela de §5.5. */
const STATUS_DESCRIPTION: Record<number, string> = {
  400: 'Bad request: the body is not JSON or a required field is missing.',
  401: 'Missing or invalid `X-Admin-Token`.',
  404: 'Resource not found.',
  409: 'An ingestion run is already in progress.',
  410: 'Search history expired (30-day retention).',
  422: 'Request failed validation; the offending paths travel in `error.details.fields`.',
  429: 'Client rate limit exceeded; see `Retry-After` and `error.retry_after_seconds`.',
  500: 'Unclassified internal error. Never exposes a stack trace.',
  502: 'The LLM answered invalid and the single repair failed (only with `strict_llm=true`).',
  503: 'No cached catalog / required dependency unavailable.',
};

export interface ErrorResponseSpec {
  status: number;
  /** Sobrescreve o código de `codeForStatus` (ex.: `/readyz` responde `NOT_READY`, não `SOURCE_UNAVAILABLE`). */
  code?: ErrorCode;
  description?: string;
}

function errorResponse(spec: ErrorResponseSpec): MethodDecorator {
  const code = spec.code ?? codeForStatus(spec.status);

  return ApiResponse({
    status: spec.status,
    description: spec.description ?? STATUS_DESCRIPTION[spec.status] ?? 'Error.',
    content: {
      'application/json': {
        // `allOf` mantém o envelope único referenciado (deref do `$ref`) e ancora
        // o código daquele status: o mesmo status nunca aparece com dois códigos.
        schema: {
          allOf: [
            { $ref: getSchemaPath(ErrorEnvelope) },
            {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: { code: { type: 'string', enum: [code] } },
                },
              },
            },
          ],
        },
      },
    },
  });
}

/**
 * Documenta os status de erro de uma operação com o envelope único de §5.5.
 *
 * Cada status vira `ErrorEnvelope` + o `error.code` que a tabela de §5.5 manda
 * naquele status (`codeForStatus`), então o par status→código é declarado uma
 * vez só e o frontend sabe o que esperar sem ler descrição.
 *
 * `@ApiExtraModels` registra o componente: `getSchemaPath` devolve o `$ref` como
 * texto e não o inscreve em `components.schemas` sozinho.
 */
export function ApiErrorResponses(
  ...entries: ReadonlyArray<number | ErrorResponseSpec>
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(ErrorEnvelope),
    ...entries.map((entry) => errorResponse(typeof entry === 'number' ? { status: entry } : entry)),
  );
}
