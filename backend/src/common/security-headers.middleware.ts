import type { RequestHandler } from 'express';

/**
 * Headers de borda da API (`docs/app/02-arquitetura.md` §8).
 *
 * Sem `helmet` de propósito: a API só devolve JSON, o CSP fica no nginx que
 * serve a SPA, e uma dependência nova aqui precisaria de `pnpm install` (sem rede
 * nesta máquina) e de auditoria de lockfile — que ainda não existe. Quando o
 * `pnpm-lock.yaml` estiver commitado, `helmet` substitui este middleware sem
 * mudar o contrato.
 */
export const securityHeaders: RequestHandler = (_request, response, next): void => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  // A API nunca é embutida em frame; a SPA é quem precisa decidir isso.
  response.setHeader('X-Frame-Options', 'DENY');
  next();
};
