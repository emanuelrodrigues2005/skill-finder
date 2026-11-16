import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SwaggerModule } from '@nestjs/swagger';

import { applyGlobalPrefix, openApiOptions } from '../main';
import { OpenApiDocumentModule } from './openapi-document.module';

/**
 * Seam único de geração do contrato (#23): dois chamadores, e ninguém mais chama
 * `SwaggerModule.createDocument` — `scripts/generate-openapi.ts` (escreve
 * `openapi.yaml`) e o `bootstrap()` (monta o Scalar em `/docs`, só fora de
 * produção). Um documento só, então `/docs` não tem como mentir sobre o artefato.
 *
 * A app efêmera nasce do `OpenApiDocumentModule` — o grafo do documento, que o
 * runtime **não** monta — e é fechada no `finally`: cada build abre e fecha a sua
 * própria app, sem deixar handles de pé no `ts-node` nem no teste.
 *
 * O Scalar não entra aqui: `@scalar/nestjs-api-reference` é carregado por
 * `await import` dentro de `setupApiDocs()`, para que gerar o documento não puxe
 * a UI.
 *
 * `abortOnError: false` é deliberado: com o default (`true`), um erro de DI —
 * por exemplo, o `PrismaService` sem banco — chama `process.abort()`, que mata o
 * processo **sem stack** e sem passar pelo `finally`. Desligado, o erro sobe e
 * quem chamou reporta.
 */
export async function buildOpenApiDocument(): Promise<OpenAPIObject> {
  const app = await NestFactory.create(OpenApiDocumentModule, {
    logger: false,
    abortOnError: false,
  });

  try {
    // O prefixo entra antes de gerar: os paths saem como `/api/v1/...` e os três
    // de `PUBLIC_ROUTES` continuam na raiz.
    applyGlobalPrefix(app);
    await app.init();

    return SwaggerModule.createDocument(app, openApiOptions());
  } finally {
    await app.close();
  }
}
