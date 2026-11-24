import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { requestIdMiddleware } from './common/request-id.middleware';
import { securityHeaders } from './common/security-headers.middleware';
import { AppConfigService } from './config/config.module';
import { setupApiDocs } from './docs/setup-api-docs';

export const GLOBAL_PREFIX = 'api/v1';

/** Saúde e métricas ficam fora do prefixo versionado: smoke test e Prometheus. */
export const PUBLIC_ROUTES = ['healthz', 'readyz', 'metrics'] as const;

export const HTTP_PORT = 8000;

const DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://localhost:8081'];

/**
 * Documento OpenAPI sem `servers`: os paths já saem com o prefixo global
 * aplicado (`applyGlobalPrefix`), então declarar `servers: /api/v1` resolvia cada
 * rota para `/api/v1/api/v1/...` — no Swagger UI e no `openapi.yaml`.
 *
 * O esquema `adminToken` existe para o `X-Admin-Token` ser legível por máquina;
 * ele é aplicado **por operação** (`@ApiSecurity('adminToken')`), nunca global —
 * as rotas públicas não têm auth. O valor do token é segredo de servidor e não
 * aparece no documento.
 */
export function openApiOptions(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Skill Finder API')
    .setVersion('0.1.0')
    .setDescription('Natural-language search over the skills.sh catalog (F2.2: skeleton).')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Admin-Token' }, 'adminToken')
    .build();
}

export function applyGlobalPrefix(app: INestApplication): void {
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: [...PUBLIC_ROUTES] });
}

/** Opções de CORS do ambiente de desenvolvimento (somente fora de produção).
 * Exportadas para teste: o CORS é o tipo de coisa que alguém "conserta" quando
 * o navegador reclama, e `admin`/`metrics` não podem entrar em `allowedHeaders`. */
export const DEV_CORS_OPTIONS = {
  origin: DEV_CORS_ORIGINS,
  methods: ['GET', 'POST'],
  allowedHeaders: ['content-type', 'x-request-id'],
} as const;
/**
 * Everything the app needs besides the routes: security headers and request id
 * first, then the prefix and graceful shutdown for Prisma.
 *
 * Exportado para o teste e2e exercitar exatamente a mesma configuração do runtime.
 */

export function configureApp(app: INestApplication): INestApplication {
  const config = app.get(AppConfigService);
  const express = app as NestExpressApplication;

  // Um único salto de proxy na frente (o ALB, ADR-015): `req.ip` é a última
  // entrada do `X-Forwarded-For`, a que o ALB anexa, e não um header forjado
  // pelo cliente — do contrário o rate limit por IP (§8.4) seria burlável.
  express.set('trust proxy', 1);
  // Fingerprint do framework fora do header; os demais headers vêm do middleware.
  express.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(requestIdMiddleware);
  app.useLogger(app.get(Logger));
  applyGlobalPrefix(app);

  if (!config.isProd) {
    // Em produção a SPA e a API compartilham a origem (nginx); estas origens
    // existem só para o Vite de desenvolvimento.
    app.enableCors(DEV_CORS_OPTIONS);
  }

  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);

  // A UI de referência (§Documentação da API) tem fiação própria em
  // `src/docs/setup-api-docs.ts`: `/docs`, `/docs-json` e o bundle local da UI.
  // A guarda de produção está lá — em produção esta chamada não monta nada.
  await setupApiDocs(app);

  await app.listen(HTTP_PORT, '0.0.0.0');
}

// Guard para que testes e o gerador de OpenAPI importem `configureApp` sem subir servidor.
if (require.main === module) {
  void bootstrap();
}
