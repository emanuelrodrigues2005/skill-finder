import { Module } from '@nestjs/common';

import { AppModule } from '../app.module';

/**
 * Grafo que existe **só** para gerar `openapi.yaml`.
 *
 * Desde a #49 ele é o próprio `AppModule`: as duas rotas de admin deixaram de ser
 * contract-only e entraram no runtime pelo `AdminModule` (o `search` já entrara
 * pela F2.6). O módulo continua existindo como seam do documento — o gerador e o
 * `buildOpenApiDocument()` importam **este** arquivo, não o `AppModule`
 * diretamente, então trocar o grafo do documento é uma decisão local.
 */
@Module({ imports: [AppModule] })
export class OpenApiDocumentModule {}
