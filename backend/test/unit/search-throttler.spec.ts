/**
 * Issue #13 — o guard do rate limit da busca (decisões D1, D2 e D3).
 *
 * Contrato exigido de `backend/src/search/search-throttler.guard.ts`:
 *
 *   @Injectable()
 *   export class SearchThrottlerGuard extends ThrottlerGuard {
 *     protected throwThrottlingException(
 *       context: ExecutionContext,
 *       detail: ThrottlerLimitDetail,
 *     ): Promise<void>;
 *   }
 *
 * O `ThrottlerGuard` puro (v6) responde `429` com
 * `"ThrottlerException: Too Many Requests"`, sem `error.code`, sem `details` e
 * com o header `Retry-After-<nome do throttler>` (o sufixo vem do throttler
 * nomeado). §5.5 exige o envelope `{request_id, error: {code, message, details,
 * retry_after_seconds}}` e o header `Retry-After` — é por isso que D3 manda
 * sobrescrever `throwThrottlingException` em vez de usar o guard de fábrica.
 *
 * Este caso pina a unidade do contrato: `ttl` chega em **milissegundos**
 * (`60000`) e `window_seconds` sai em **segundos** (`60`); o retry chega em
 * segundos (`timeToExpire: 42`) e sai em segundos (`42`, nunca `42000`).
 * `A` (e2e) cobra o mesmo envelope atravessando o filtro HTTP.
 *
 * O guard é resolvido pelo mesmo injetor do runtime (`ThrottlerModule` global +
 * `AppConfigModule`), porque D2 também precisa de `IP_HASH_SALT` para o
 * `client_hash`; um `new` manual fixaria a aridade do construtor à toa.
 */
import type { ExecutionContext } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerModule, type ThrottlerLimitDetail } from '@nestjs/throttler';

import { AppConfigModule } from '@/config/config.module';
import { SearchThrottlerGuard } from '@/search/search-throttler.guard';

/** Acesso ao método `protected` sem depender de subclasse (que perderia o DI). */
interface ThrottlingInternals {
  throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void>;
}

interface RecordedResponse {
  readonly headers: Map<string, string | number>;
  header(name: string, value: string | number): void;
  setHeader(name: string, value: string | number): void;
}

function fakeResponse(): RecordedResponse {
  const headers = new Map<string, string | number>();
  return {
    headers,
    header(name: string, value: string | number): void {
      headers.set(name.toLowerCase(), value);
    },
    setHeader(name: string, value: string | number): void {
      headers.set(name.toLowerCase(), value);
    },
  };
}

/** `ExecutionContext` mínimo: só o que o override lê (`switchToHttp().getResponse()`). */
function fakeContext(response: RecordedResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {}, ip: '127.0.0.1' }),
      getResponse: () => response,
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('SearchThrottlerGuard (issue #13, §5.5 + D3)', () => {
  let internals: ThrottlingInternals;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'search-minute', ttl: 60_000, limit: 10 }],
        }),
      ],
      providers: [SearchThrottlerGuard],
    }).compile();

    // A instância é a do runtime; `unknown` evita afirmar a forma do `protected`
    // no ponto do `get` (o cast fica explícito na interface local).
    const guard: unknown = moduleRef.get(SearchThrottlerGuard);
    internals = guard as ThrottlingInternals;
  });

  it('E. throws the §5.5 envelope with Retry-After in seconds', async () => {
    const response = fakeResponse();
    const detail: ThrottlerLimitDetail = {
      key: 'a'.repeat(64),
      tracker: 'b'.repeat(64),
      totalHits: 11,
      // Bloqueado no teto da janela: o cliente volta em 42 s.
      // (`timeToBlockExpire` e `timeToExpire` coincidem porque o block dura o
      // resto da janela; qualquer um dos dois vale como Retry-After.)
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 42,
      ttl: 60_000,
      limit: 10,
    };

    let thrown: unknown;
    try {
      await internals.throwThrottlingException(fakeContext(response), detail);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const error = thrown as HttpException;
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

    const body = error.getResponse() as Record<string, unknown>;

    // D3: o código é o do contrato, não o 429 genérico do `ThrottlerException`.
    expect(body.code).toBe('RATE_LIMITED');
    expect(body).not.toHaveProperty('statusCode');
    // §5.5: `details` traz o teto e a janela em segundos; `ttl` chega em ms.
    expect(body.details).toEqual({ limit: 10, window_seconds: 60 });
    // D3: o retry está no corpo e no header, e o header é o `Retry-After` puro
    // (nunca `Retry-After-search-minute`).
    expect(body.retry_after_seconds).toBe(42);
    expect(Number(response.headers.get('retry-after'))).toBe(42);
    // O texto do guard de fábrica não vaza para a interface.
    expect(String(body.message).toLowerCase()).not.toContain('throttlerexception');
    expect(String(body.message).length).toBeGreaterThan(0);
  });
});
