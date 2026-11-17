import { Module } from '@nestjs/common';

import { AdminIngestController } from './contract-admin.controller';

/**
 * Endpoints `x-internal` de administração (§5.1), contract-only.
 *
 * Superfície interna (§5.1), contract-only: nenhum cliente de frontend tem o
 * `X-Admin-Token`. Só o `OpenApiDocumentModule` (gerador) o importa; o runtime
 * não monta estas rotas, e o handler existe apenas para falhar (`contractOnly`)
 * se alguém as montar antes da F2.3.
 */
@Module({
  controllers: [AdminIngestController],
})
export class ContractAdminModule {}
