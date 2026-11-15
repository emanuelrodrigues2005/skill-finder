import type { Options as PinoHttpOptions } from 'pino-http';

import type { Env } from '../../config/env.schema';
import { newRequestId } from '../request-id.middleware';

const SERVICE_NAME = 'api';

export const REDACTED = '[REDACTED]';

/**
 * Campos proibidos em log de `docs/app/02-arquitetura.md` §8.5.
 *
 * Duas famílias: headers de credencial (e o IP que o proxy repassa, que em claro
 * também é PII) e os segredos do objeto de config de §3 — que é camelCase, não
 * snake_case. `*.campo` cobre o caso de o objeto vir aninhado dentro de outro
 * (ex.: `config.postgres.password`). O estreitamento é verificado por
 * `test/log-redaction.spec.ts`.
 */
export const REDACT_PATHS: string[] = [
  // credenciais do request
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-admin-token"]',
  // IP em claro: o nginx manda `X-Forwarded-For`/`X-Real-IP` e o socket traz
  // `remoteAddress`; nenhum dos três pode ir para o log (§8.5).
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
  'req.remoteAddress',
  // payload cru (snake_case) e objeto de config (camelCase)
  'api_key',
  'token',
  'llmApiKey',
  'databaseUrl',
  'ipHashSalt',
  'postgres.password',
  '*.api_key',
  '*.token',
  '*.authorization',
  '*.llmApiKey',
  '*.databaseUrl',
  '*.ipHashSalt',
  '*.postgres.password',
];

/**
 * Opções do `nestjs-pino`/`pino-http` (§9.2). Exportada para o teste de redação
 * exercitar as mesmas opções que o processo usa — copiar a lista no teste
 * deixaria o `redact` de produção sem cobertura.
 */
export function pinoHttpOptions(env: Env): PinoHttpOptions {
  return {
    level: env.logLevel,
    // `level` como rótulo ("info") e `ts` em ISO, como no exemplo de §9.2.
    formatters: { level: (label: string) => ({ level: label }) },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    messageKey: 'message',
    // pino-http mede a resposta como `responseTime` (ms): o contrato pede `latency_ms`.
    customAttributeKeys: { responseTime: 'latency_ms' },
    redact: { censor: REDACTED, paths: REDACT_PATHS },
    genReqId: (request) => requestIdOf(request) ?? newRequestId(),
    customProps: (request, response) => ({
      service: SERVICE_NAME,
      request_id: requestIdOf(request) ?? 'unknown',
      route: `${request.method ?? 'GET'} ${requestRoute(request)}`,
      status: response.statusCode,
    }),
    customLogLevel: (_request, response, error) => {
      if (error !== undefined) {
        return 'error';
      }
      return response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info';
    },
  };
}

function requestRoute(request: object): string {
  const route = (request as { route?: { path?: string } }).route;
  return route?.path ?? 'unmatched';
}

function requestIdOf(request: object): string | undefined {
  return (request as { requestId?: string }).requestId;
}
