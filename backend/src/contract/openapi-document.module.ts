import { Module } from '@nestjs/common';

import { AppModule } from '../app.module';
import { ContractAdminModule } from './contract-admin.module';
import { ContractModule } from './contract.module';

/**
 * Grafo que existe **só** para gerar `openapi.yaml`.
 *
 * O contrato v0 descreve sete rotas que o serviço ainda não serve (F2.3–F2.6 as
 * implementa): elas entram no documento por este módulo, importado apenas por
 * `scripts/generate-openapi.ts`. O runtime sobe de `AppModule` e continua
 * respondendo 404 nessas rotas — "não existe ainda" em vez de um 500 que fingiria
 * uma falha de servidor. Quando a F2.4 montar o `search.controller` real no
 * `AppModule`, o grafo do documento já terá o mesmo path pelo módulo de verdade,
 * sem rota duplicada.
 */
@Module({ imports: [AppModule, ContractModule, ContractAdminModule] })
export class OpenApiDocumentModule {}
