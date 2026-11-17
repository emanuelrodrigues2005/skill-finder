/**
 * Rate limit de `POST /api/v1/search` (issue #13, §8.4, D1–D3).
 *
 * **D1 — guard na rota, não `APP_GUARD`.** Um guard global contaria também
 * `/healthz`, `/readyz` e `/metrics`: um probe throttled faz o orquestrador
 * reiniciar o container em loop e derruba a disponibilidade justamente quando o
 * limite é atingido. Por isso o `@UseGuards` fica no handler da busca
 * (`search.controller.ts`) e os probes continuam livres.
 *
 * **D2 — bucket por `client_hash`.** A chave é `sha256(IP_HASH_SALT:ip)` — a
 * mesma função que grava `search_request.client_hash` (`client-hash.ts`), então
 * o limite conta exatamente o cliente que o histórico identifica. O IP vem de
 * `X-Real-IP`, que o nginx **sobrescreve** com `$remote_addr`
 * (`frontend/nginx.conf`); `X-Forwarded-For` nunca é lido porque é uma lista que
 * o cliente escolhe — confiar nele daria um bucket novo a cada requisição.
 * `req.ip` é só o fallback de quem fala direto com a API (dev, testes).
 *
 * **D3 — o 429 do contrato (§5.5), não o do `ThrottlerException`.** O guard de
 * fábrica responde `"ThrottlerException: Too Many Requests"`, sem
 * `error.code`/`details`/`retry_after_seconds`, e o header sai com o sufixo do
 * throttler nomeado (`Retry-After-search-minute`). Sobrescrever
 * `throwThrottlingException` mantém o envelope único e o `Retry-After` puro.
 */
import { ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';

import { ERROR_CODES } from '../common/errors/error-codes';
import { ApiError } from '../common/errors/http-exception.filter';
import { AppConfigService } from '../config/config.module';

import { clientHash, resolveClientIp } from './client-hash';

/** Mensagem do 429: fala de busca (o único recurso limitado), não de "requests". */
const RATE_LIMITED_MESSAGE = 'Too many searches from this client. Try again later.';

/** Cabeçalho que o nginx grava com `$remote_addr` (nunca o `X-Forwarded-For`). */

@Injectable()
export class SearchThrottlerGuard extends ThrottlerGuard {
  /**
   * O construtor é declarado só para injetar `AppConfigService` (o sal do hash);
   * os três primeiros parâmetros são os do `ThrottlerGuard` de v6 e precisam ser
   * repassados ao `super` — o `onModuleInit` dele é quem monta a lista de
   * throttlers e amarra `getTracker`/`generateKey`.
   */
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfigService,
  ) {
    super(options, storageService, reflector);
  }

  /**
   * D2: a chave do bucket é o `client_hash` do histórico.
   *
   * `req` é o objeto do Express, e o `ThrottlerGuard` o tipa como
   * `Record<string, any>`; o cast local mantém `no-unsafe-*` satisfeito sem
   * alargar a assinatura herdada.
   */
  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    return Promise.resolve(clientHash(this.clientIp(req), this.config.env.ipHashSalt));
  }

  /**
   * D3: `Retry-After` numérico em **segundos** (o `ttl` do throttler chega em
   * **milissegundos**) e o envelope `RATE_LIMITED` com `{limit, window_seconds}`.
   *
   * `timeToBlockExpire` é o tempo até o bloqueio cair e é o que o cliente tem de
   * esperar; `timeToExpire` é o fallback de um throttler sem `blockDuration`.
   * O piso de 1 s evita `Retry-After: 0` no instante exato do vencimento.
   *
   * Não é `async` de propósito: o método só lança (`require-await` do ESLint
   * apontaria um `await` inventado), e o `handleRequest` do guard base já faz
   * `await` na chamada.
   */
  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    const windowSeconds = Math.round(detail.ttl / 1000);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(detail.timeToBlockExpire > 0 ? detail.timeToBlockExpire : detail.timeToExpire),
    );

    // Os headers `X-RateLimit-*` do guard de fábrica saem com o sufixo do
    // throttler nomeado (`-search-minute`); §5.1/§5.5 documentam os nomes puros,
    // então o 429 publica os três sem sufixo, ao lado do `Retry-After`.
    response.setHeader('Retry-After', retryAfterSeconds);
    response.setHeader('X-RateLimit-Limit', detail.limit);
    response.setHeader('X-RateLimit-Remaining', 0);
    response.setHeader('X-RateLimit-Reset', retryAfterSeconds);

    throw new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      ERROR_CODES.RATE_LIMITED,
      RATE_LIMITED_MESSAGE,
      { limit: detail.limit, window_seconds: windowSeconds },
      retryAfterSeconds,
    );
  }

  /**
   * IP do cliente, resolvido pelo MESMO helper que o serviço usa para gravar
   * `client_hash` — senão o bucket e o histórico falam de clientes diferentes.
   */
  private clientIp(req: Record<string, unknown>): string {
    return resolveClientIp({
      headers: req.headers as Record<string, unknown> | undefined,
      ip: typeof req.ip === 'string' ? req.ip : undefined,
    });
  }


}
