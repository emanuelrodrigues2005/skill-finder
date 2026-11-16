import { Module } from '@nestjs/common';

import {
  CategoriesController,
  SearchController,
  SearchesController,
  SkillsController,
} from './contract.controller';

/**
 * Contrato público v0 (§5.1): cinco rotas sob `/api/v1`, sem serviço por trás.
 *
 * O runtime **não** monta estes controllers: quem importa este módulo é o
 * `OpenApiDocumentModule`, usado apenas por `pnpm openapi:generate`. Assim o
 * `openapi.yaml` descreve o que foi combinado sem que `/api/v1/search & cia`
 * respondam algo que ainda não existe. O handler lança `contractOnly` de
 * propósito — se um dia o módulo entrar no runtime por engano, a falha é alta e
 * visível, não um dado inventado.
 */
@Module({
  controllers: [SearchController, SearchesController, CategoriesController, SkillsController],
})
export class ContractModule {}
