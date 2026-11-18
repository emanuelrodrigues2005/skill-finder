/**
 * Módulo do catálogo (`docs/app/02-arquitetura.md` §3, §7.1–7.3).
 *
 * Quem decide a fonte e o repositório é a configuração injetada, não o
 * ambiente: `forRoot` recebe as instâncias prontas (fonte, repositório, ou o
 * `PrismaClient` para construir o repositório de produção) e as expõe por
 * token. O mesmo módulo serve à produção (`source` + `prisma`) e ao teste
 * (`source` + `repository` em memória) sem `if` espalhado pelo código. Sem
 * fonte injetada, `adapter` escolhe entre a fixture congelada (`fixture`,
 * padrão) e o único adaptador real (`html`, #47) — `json` não existe mais.
 *
 * Este módulo **não** está registrado em `app.module.ts` ainda: quem monta a
 * busca (F2.6) chama `CatalogModule.forRoot` e é o dono dos tokens. Construir o
 * módulo não abre socket nem toca o banco.
 */
import { type DynamicModule, Module } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { CatalogRepository } from './catalog-repository';
import { createFixtureSource } from './fixture-source';
import { createHtmlSource, type HtmlSourceClock } from './html-source';
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
  /** Nome do adaptador (`SKILL_SOURCE_KIND`): `fixture` (padrão) ou `html`. */
  readonly adapter?: string;
  /** Fonte já construída; quando presente, vence a fiação do adaptador. */
  readonly source?: SkillSource;
  /** Caminho da fixture, quando a fonte não é injetada. */
  readonly fixturePath?: string;
  /** Base fixa do adaptador `html` (`SKILL_SOURCE_BASE_URL`). */
  readonly baseUrl?: string;
  /** Requisições por segundo do adaptador `html` (`SKILL_SOURCE_RPS`). */
  readonly rps?: number;
  /** Timeout por requisição do adaptador `html`. */
  readonly timeoutMs?: number;
  /** Relógio injetado do adaptador `html` (o teste prova o 1 req/s sem dormir). */
  readonly clock?: HtmlSourceClock;
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
  switch (options.adapter ?? 'fixture') {
    case 'fixture':
      return options.fixturePath === undefined
        ? createFixtureSource()
        : createFixtureSource({ path: options.fixturePath });
    case 'html':
      // Produção: base fixa + 1 req/s (SKILL_SOURCE_RPS). Nenhuma URL de skill
      // vem do banco — o adaptador monta a partir do `source_key` do sitemap.
      return createHtmlSource({
        baseUrl: options.baseUrl,
        rps: options.rps,
        timeoutMs: options.timeoutMs,
        clock: options.clock,
      });
    default:
      throw new Error(
        `SKILL_SOURCE_KIND "${String(options.adapter)}" não existe: use html ou fixture`,
      );
  }
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
