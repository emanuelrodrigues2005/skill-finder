import { ApiProperty } from '@nestjs/swagger';

import { ERROR_CODES, type ErrorCode } from '../../common/errors/error-codes';

/**
 * Todos os códigos do catálogo (`ERROR_CODES`), na ordem em que estão declarados.
 *
 * São nove em §5.5; `UNAUTHORIZED`, `FORBIDDEN` e `CONFLICT` entram pelo §5.1
 * (o `X-Admin-Token` e a ingestão concorrente) e completam o enum.
 */
const ERROR_CODE_VALUES = Object.values(ERROR_CODES) as ErrorCode[];

/**
 * Bloco `error` do envelope único de §5.5.
 *
 * O nome da classe é o nome do componente no `openapi.yaml`
 * (`#/components/schemas/ErrorBody`), então renomeá-la é mudança de contrato.
 */
export class ErrorBody {
  @ApiProperty({
    enum: ERROR_CODE_VALUES,
    description:
      'Stable UPPER_SNAKE code of docs/app/02-arquitetura.md §5.5. Clients pick the message by code, never by text.',
  })
  code!: ErrorCode;

  @ApiProperty({ type: String, description: 'Human-readable message. Never a stack trace.' })
  message!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Closed set, on every status: `fields` (422 validation errors), `reason` (503 readiness), `limit`, `window_seconds` and `scope` (429, `scope` = `global` when the daily LLM budget is exhausted), `run_id` (409 ingest already running) and `expires_at` (410 history expired). Any other key is dropped by the error filter, so upstream messages, stack traces and driver errors never reach the public body. Empty object when there is no detail.',
  })
  details!: Record<string, unknown>;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    required: false,
    description:
      'Seconds until the client may retry. Only meaningful on 429; omitted everywhere else.',
  })
  retry_after_seconds?: number | null;
}

/**
 * Envelope de erro único do contrato v0: `{request_id, error}`.
 *
 * Todo response com status ≥400 do `openapi.yaml` referencia este componente, e
 * `request_id` correlaciona a resposta com o log.
 */
export class ErrorEnvelope {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Request id echoed back (header `X-Request-Id`); null only when the request never reached the middleware.',
  })
  request_id!: string | null;

  @ApiProperty({ type: () => ErrorBody })
  error!: ErrorBody;
}
