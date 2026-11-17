import { Module } from '@nestjs/common';

import { AppModule } from '../app.module';
import { ContractAdminModule } from './contract-admin.module';

/**
 * Grafo que existe **só** para gerar `openapi.yaml`.
 *
 * Desde a F2.6 as cinco rotas públicas são controllers de verdade e entram no
 * documento pelo `AppModule` (via `SearchModule`): não existe mais um
 * `ContractModule` vazio no caminho. O que ainda entra no documento **só por
 * aqui** são os dois endpoints de admin (`ContractAdminModule`): eles continuam
 * fora do runtime até a F2.9 e o `AppModule` responde 404 neles — "não existe
 * ainda" em vez de um 500 que fingiria uma falha de servidor.
 */
@Module({ imports: [AppModule, ContractAdminModule] })
export class OpenApiDocumentModule {}
