/**
 * Módulo do catálogo (`docs/app/02-arquitetura.md` §3, §7.1–7.3).
 *
 * Quem decide a fonte e o repositório é a configuração injetada, não o
 * ambiente: `forRoot` recebe as instâncias prontas (fonte, repositório, ou o
 * `PrismaClient` para construir o repositório de produção) e as expõe por
 * token. O mesmo módulo serve à produção (`source` + `prisma`) e ao teste
 * (`source` + `repository` em memória) sem `if` espalhado pelo código.
 *
 * Este módulo **não** está registrado em `app.module.ts` ainda: quem monta a
 * busca (F2.6) chama `CatalogModule.forRoot` e é o dono dos tokens. Construir o
 * módulo não abre socket nem toca o banco.
 */
import { type DynamicModule, Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { CatalogRepository } from './catalog-repository';
import { createFixtureSource } from './fixture-source';
import { PrismaCatalogRepository } from './prisma-catalog.repository';
import type { SkillSource } from './skill-source';

/** Token de injeção da porta `CatalogRepository`. */
export const CATALOG_REPOSITORY = 'CATALOG_REPOSITORY';

/** Token de injeção da porta `SkillSource` ativa. */
export const CATALOG_SOURCE = 'CATALOG_SOURCE';

/** Token do nome do adaptador gravado em `ingest_run.adapter`. */
export const CATALOG_ADAPTER = 'CATALOG_ADAPTER';

/** Configuração do módulo; nada aqui é lido do ambiente. */
export interface CatalogModuleOptions {
  /** Nome do adaptador (`SKILL_SOURCE_KIND`); padrão `fixture`. */
  readonly adapter?: string;
  /** Fonte já construída; sem ela, `fixture` lê a amostra congelada. */
  readonly source?: SkillSource;
  /** Caminho da fixture, quando a fonte não é injetada. */
  readonly fixturePath?: string;
  /** Repositório já construído (duplo de teste); vence `prisma`. */
  readonly repository?: CatalogRepository;
  /** Cliente Prisma, para o repositório de produção. */
  readonly prisma?: PrismaClient;
}

@Module({})
export class CatalogModule {
  /** Módulo dinâmico com `CATALOG_SOURCE` e `CATALOG_REPOSITORY` resolvidos. */
  static forRoot(options: CatalogModuleOptions = {}): DynamicModule {
    return {
      module: CatalogModule,
      providers: [
        { provide: CATALOG_ADAPTER, useValue: options.adapter ?? 'fixture' },
        {
          provide: CATALOG_SOURCE,
          useFactory: (): SkillSource => createSource(options),
        },
        {
          provide: CATALOG_REPOSITORY,
          useFactory: (): CatalogRepository => createRepository(options),
        },
      ],
      exports: [CATALOG_ADAPTER, CATALOG_SOURCE, CATALOG_REPOSITORY],
    };
  }
}

function createSource(options: CatalogModuleOptions): SkillSource {
  if (options.source !== undefined) {
    return options.source;
  }
  return options.fixturePath === undefined
    ? createFixtureSource()
    : createFixtureSource({ path: options.fixturePath });
}

function createRepository(options: CatalogModuleOptions): CatalogRepository {
  if (options.repository !== undefined) {
    return options.repository;
  }
  if (options.prisma !== undefined) {
    return new PrismaCatalogRepository(options.prisma);
  }
  // Sem banco e sem duplo explícito, a ingestão não tem onde gravar: falhar no
  // boot é melhor do que servir um catálogo que nunca é persistido.
  throw new Error('CatalogModule.forRoot requer `prisma` ou `repository`');
}
