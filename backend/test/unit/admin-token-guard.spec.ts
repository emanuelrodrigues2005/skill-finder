/**
 * Gate do `AdminTokenGuard` (#49): a rota de ingestão **falha fechada**.
 *
 * O e2e prova o `401` por HTTP; aqui ficam os quatro ramos que decidem a
 * resposta, incluindo o que não tem como aparecer no e2e (o app de teste sempre
 * tem `ADMIN_TOKEN`): sem token configurado, **ninguém** entra. Esse é o ramo
 * que uma regressão silenciosa abriria — um `if` esquecido deixaria a única rota
 * de escrita do catálogo aberta em dev.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { ADMIN_TOKEN_REJECTED, AdminTokenGuard } from '@/admin/admin-token.guard';
import { ApiError } from '@/common/errors/http-exception.filter';
import { AppConfigService } from '@/config/config.module';

function configFrom(raw: Record<string, string | undefined>): AppConfigService {
  return new AppConfigService({
    get: (key: string) => raw[key],
  } as unknown as ConfigService);
}

/** Contexto mínimo do guard: só o `headers` do request importa. */
function context(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

function rejectReason(run: () => boolean): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('o guard deveria ter recusado');
}

/** Corpo da exceção de contrato: é o que o filtro de §5.5 publica. */
function bodyOf(error: unknown): { code: string; message: string; details: unknown } {
  return (error as ApiError).getResponse() as {
    code: string;
    message: string;
    details: unknown;
  };
}

describe('AdminTokenGuard (#49)', () => {
  it('accepts the configured token', () => {
    const guard = new AdminTokenGuard(configFrom({ ENV: 'dev', ADMIN_TOKEN: 'operator-token-com-32-caracteres' }));

    expect(guard.canActivate(context({ 'x-admin-token': 'operator-token-com-32-caracteres' }))).toBe(true);
  });

  it('fails closed when ADMIN_TOKEN is not configured', () => {
    const guard = new AdminTokenGuard(configFrom({ ENV: 'dev' }));

    const error = rejectReason(() => guard.canActivate(context({ 'x-admin-token': 'anything' })));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).getStatus()).toBe(401);
    expect(bodyOf(error)).toEqual({
      code: 'UNAUTHORIZED',
      message: ADMIN_TOKEN_REJECTED,
      details: {},
    });
  });

  it('rejects a missing, wrong or non-string header without echoing the value', () => {
    const guard = new AdminTokenGuard(configFrom({ ENV: 'dev', ADMIN_TOKEN: 'operator-token-com-32-caracteres' }));

    for (const headers of [
      {},
      { 'x-admin-token': 'wrong-token' },
      { 'x-admin-token': ['operator-token-com-32-caracteres', 'wrong-token'] },
    ]) {
      const error = rejectReason(() => guard.canActivate(context(headers)));
      expect((error as ApiError).getStatus()).toBe(401);
      // A mensagem é a mesma para todo caso: não diz se o token existe.
      expect(bodyOf(error).message).toBe(ADMIN_TOKEN_REJECTED);
    }
  });
});
