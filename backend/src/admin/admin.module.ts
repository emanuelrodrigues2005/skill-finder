/**
 * Módulo do admin (§5.1, issue #49): as duas rotas `x-internal` que rodam a
 * ingestão **como serviço**, com a API no ar.
 *
 * Ele é importado pelo `AppModule` — antes, as rotas existiam só no documento
 * (`ContractAdminModule`, importado apenas pelo gerador do OpenAPI) e o runtime
 * respondia 404. A fiação mora aqui, e não em `CatalogModule.forRoot`, porque o
 * grafo de runtime resolve `PrismaService` e `AppConfigService` por injeção
 * (`forRoot` recebe instâncias já prontas). A construção da fonte continua sendo
 * a do catálogo (`createSource`), num `switch` só.
 *
 * O quê este módulo **não** faz: não agenda a ingestão. O ciclo de 6 h é do
 * agendador (fora da #49) e o bootstrap é `make seed`; o que existe aqui é a
 * execução manual do operador — refresh de até 20 chaves por request.
 */
import { Module } from '@nestjs/common';

import {
  CATALOG_ADAPTER,
  CATALOG_REPOSITORY,
  CATALOG_SOURCE,
  createSource,
} from '../catalog/catalog.module';
import { PrismaCatalogRepository } from '../catalog/prisma-catalog.repository';
import { AppConfigService } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

import { AdminIngestController } from './admin-ingest.controller';
import { AdminTokenGuard } from './admin-token.guard';
import { INGEST_RUN_LOG } from './admin.tokens';
import { IngestService } from './ingest.service';

/** Implementação única compartilhada pela porta de escrita e a de leitura. */
const CATALOG_REPOSITORY_IMPL = 'CATALOG_REPOSITORY_IMPL';

@Module({
  controllers: [AdminIngestController],
  providers: [
    AdminTokenGuard,
    IngestService,
    {
      provide: CATALOG_REPOSITORY_IMPL,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): PrismaCatalogRepository =>
        new PrismaCatalogRepository(prisma),
    },
    // A ingestão escreve (`CatalogRepository`) e a listagem lê (`IngestRunLog`)
    // do **mesmo** repositório: `useExisting` evita duas instâncias da mesma
    // classe e mantém um ponto de troca só para os duplos de teste.
    { provide: CATALOG_REPOSITORY, useExisting: CATALOG_REPOSITORY_IMPL },
    { provide: INGEST_RUN_LOG, useExisting: CATALOG_REPOSITORY_IMPL },
    {
      provide: CATALOG_SOURCE,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        createSource({
          adapter: config.env.skillSourceKind,
          baseUrl: config.env.skillSourceBaseUrl,
          rps: config.env.skillSourceRps,
        }),
    },
    {
      provide: CATALOG_ADAPTER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): string => config.env.skillSourceKind,
    },
  ],
})
export class AdminModule {}
