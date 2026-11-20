/**
 * Guard do `X-Admin-Token` (§5.1, §8.1; issue #49).
 *
 * As duas rotas de admin **escrevem** no catálogo, então não podem existir sem
 * proteção. A superfície é isolada em três camadas, e nenhuma depende de rede:
 *
 * 1. **token de servidor**: comparado em tempo constante (sha256 dos dois lados
 *    + `timingSafeEqual`, que não vaza o tamanho do segredo). Sem token o app
 *    responde `401`, nunca fica aberto;
 * 2. **fora do navegador**: `x-admin-token` não está em `DEV_CORS_OPTIONS`
 *    (`test/unit/cors.spec.ts`), então a SPA não consegue enviar o header;
 * 3. **fora dos logs**: `req.headers["x-admin-token"]` é redigido pelo
 *    `pino-http` (`REDACT_PATHS`, `test/unit/log-redaction.spec.ts`).
 *
 * Em prod o `env.schema.ts` recusa o boot sem `ADMIN_TOKEN`: um guard que
 * falhasse fechado para sempre deixaria a API incapaz de popular o catálogo, e
 * isso tem de aparecer no boot, não no primeiro run.
 */
import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { AppConfigService } from '../config/config.module';

/** Nome canônico do header (o Express entrega em minúsculas). */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/** Mensagem única de recusa: não distingue "sem token" de "token errado". */
export const ADMIN_TOKEN_REJECTED = 'Missing or invalid X-Admin-Token.';

@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    const received = request.headers?.[ADMIN_TOKEN_HEADER];
    const expected = this.config.env.adminToken;

    if (
      expected === undefined ||
      typeof received !== 'string' ||
      !secretMatches(expected, received)
    ) {
      // `details` vazio: o token recebido nunca volta no corpo (nem no log, pela
      // redação de `REDACT_PATHS`).
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        ERROR_CODES.UNAUTHORIZED,
        ADMIN_TOKEN_REJECTED,
      );
    }
    return true;
  }
}

/**
 * Compara dois segredos em tempo constante.
 *
 * Comparar as strings direto (ou por `length`) vazaria o tamanho e o prefixo do
 * token via timing. O sha256 normaliza o tamanho — 32 bytes dos dois lados — e
 * `timingSafeEqual` compara sem curto-circuito.
 */
function secretMatches(expected: string, received: string): boolean {
  const left = createHash('sha256').update(expected, 'utf8').digest();
  const right = createHash('sha256').update(received, 'utf8').digest();
  return timingSafeEqual(left, right);
}
