import { randomBytes } from 'node:crypto';

import type { Request, RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-ID';

// Um id recebido só é aceito se for opaco e curto: header do cliente não é confiável.
const INCOMING_REQUEST_ID = /^[A-Za-z0-9_-]{8,72}$/;
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface RequestWithRequestId extends Request {
  requestId?: string;
}

/** ULID: 48 bits de tempo (ms) + 80 bits aleatórios, em Crockford base32. */
function ulid(): string {
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD_BASE32.charAt(Number(value & 31n))}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

export function newRequestId(): string {
  return `req_${ulid()}`;
}

/**
 * Resolves the request id for every request and echoes it in the response, so the
 * error envelope, the access log and the client all quote the same value.
 *
 * Registered with `app.use()` before the Nest middlewares: `nestjs-pino` reads
 * `requestId` in `genReqId`, so this one has to run first.
 */
export const requestIdMiddleware: RequestHandler = (
  request,
  response,
  next,
): void => {
  const incoming = request.headers[REQUEST_ID_HEADER.toLowerCase()];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId =
    typeof candidate === 'string' && INCOMING_REQUEST_ID.test(candidate)
      ? candidate
      : newRequestId();

  (request as RequestWithRequestId).requestId = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);
  next();
};
