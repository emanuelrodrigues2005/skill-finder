/**
 * Módulo da busca (§3, F2.6): as cinco rotas públicas e as portas que as
 * sustentam.
 *
 * O grafo é montado por `forRoot()` porque **nada** aqui pode depender do
 * ambiente no momento em que o decorator é avaliado: `SEARCH_CATALOG`,
 * `SEARCH_STORE`, `INTENT_PARSER` e `EXPLAIN_PORT` nascem de fábricas que injetam
 * `PrismaService` e `AppConfigService`. O mesmo `forRoot` aceita portas prontas
 * (`catalog`/`store`) — é o seam dos duplos em memória, sem nenhum `if` de teste
 * no código de produção.
 *
 * As duas portas de LLM vêm das fábricas do `LlmModule` (passo 4 e passo 7),
 * nunca daqui: quem decide entre provedor real e modo degradado é a configuração
 * `LLM_ENABLED`, num lugar só.
 */
import { type DynamicModule, Module } from '@nestjs/common';

import { MetricsModule } from '../common/metrics/metrics.module';
import { AppConfigService } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { ExplainParser } from '../llm/explain-parser';
import type { IntentParser } from '../llm/intent-parser';
import {
  createExplainParser,
  createIntentParser,
  EXPLAIN_PORT,
  INTENT_PARSER,
  type LlmModuleOptions,
} from '../llm/llm.module';
import { PrismaService } from '../prisma/prisma.service';

import { CategoriesController } from './categories.controller';
import { PrismaSearchCatalogRepository } from './prisma-search-catalog.repository';
import { PrismaSearchStoreRepository } from './prisma-search-store.repository';
import { SearchController } from './search.controller';
import { SearchThrottlerGuard } from './search-throttler.guard';
import { SEARCH_CATALOG, SEARCH_STORE } from './search.tokens';
import type { SearchCatalog } from './search-catalog.port';
import type { SearchStore } from './search-store.port';
import { SearchService } from './search.service';
import { SearchesController } from './searches.controller';
import { SkillsController } from './skills.controller';

/** Portas já construídas; vazio em produção, onde o adaptador Postgres entra. */
export interface SearchModulePorts {
  readonly catalog?: SearchCatalog;
  readonly store?: SearchStore;
}

@Module({})
export class SearchModule {
  /** Módulo dinâmico com as cinco rotas públicas e as portas resolvidas. */
  static forRoot(ports: SearchModulePorts = {}): DynamicModule {
    return {
      module: SearchModule,
      imports: [MetricsModule],
      controllers: [
        SearchController,
        SearchesController,
        CategoriesController,
        SkillsController,
      ],
      providers: [
        SearchService,
        // O guard precisa ser provider do módulo para o `onModuleInit` do
        // `ThrottlerGuard` rodar: é ele que monta a lista de throttlers e amarra
        // `getTracker`/`generateKey`. O `ThrottlerModule` é `@Global()`, então
        // as opções chegam aqui sem import extra (D1: guard na rota, não global).
        SearchThrottlerGuard,
        {
          provide: SEARCH_CATALOG,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): SearchCatalog =>
            ports.catalog ?? new PrismaSearchCatalogRepository(prisma),
        },
        {
          provide: SEARCH_STORE,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService): SearchStore =>
            ports.store ?? new PrismaSearchStoreRepository(prisma),
        },
        {
          provide: INTENT_PARSER,
          inject: [AppConfigService],
          useFactory: (config: AppConfigService): IntentParser =>
            createIntentParser(llmOptions(config.env)),
        },
        {
          // Passo 7 (§6.5, issue #42). Sai da **mesma** fábrica do passo 4 — a
          // regra "`LLM_ENABLED` escolhe o provedor" mora em `createLlmClient`.
          provide: EXPLAIN_PORT,
          inject: [AppConfigService],
          useFactory: (config: AppConfigService): ExplainParser =>
            createExplainParser(llmOptions(config.env)),
        },
      ],
      exports: [SEARCH_CATALOG, SEARCH_STORE],
    };
  }
}

/** `AppConfigService` -> opções do `LlmModule` (§3, variáveis `LLM_*`). */
function llmOptions(env: Env): LlmModuleOptions {
  return {
    enabled: env.llmEnabled,
    baseUrl: env.llmBaseUrl,
    model: env.llmModel,
    apiKey: env.llmApiKey,
    timeoutS: env.llmTimeoutS,
    // Sem esta linha `LLM_TOTAL_DEADLINE_MS` é configuração morta: o schema a lê,
    // o cliente a aceita, e o default de 7000 mascarava a ausência. Quem subisse
    // o valor no compose veria o teto de 7 s continuar valendo — no knob que
    // existe justamente para limitar custo e latência (achado do parecer da #41).
    totalDeadlineMs: env.llmTotalDeadlineMs,
  };
}
