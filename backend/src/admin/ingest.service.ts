/**
 * Execução da ingestão **com a API no ar** (`POST /api/v1/admin/ingest`, #49).
 *
 * Até a #49 o único chamador de `ingest()` era `backend/scripts/seed.ts`: não
 * havia como rodar a ingestão com o serviço de pé. Este serviço é a fronteira
 * entre a rota e a orquestração — e o lugar da **trava** que impede duas
 * execuções simultâneas.
 *
 * Por que a trava vive no processo, e não só no banco: o rodízio pediria as
 * mesmas chaves duas vezes e o rate limit do skills.sh dobraria (§7.3, D3). O
 * índice parcial `UNIQUE (status) WHERE status = 'running'` de `ingest_run`
 * continua sendo o backstop **entre** processos (`make seed` em paralelo); o
 * repositório o traduz em `IngestRunInProgressError`, que aqui vira
 * `{started: false}` também. A rota responde `409` nos dois casos.
 *
 * A execução é **síncrona** de propósito: o pedido é limitado a 20 chaves
 * (`IngestRequest`), então o run termina dentro do request e a resposta pode
 * carregar o resultado (`IngestRunOutcome`) em vez de um `run_id` para o
 * operador consultar depois.
 */
import { Inject, Injectable } from '@nestjs/common';

import { CATALOG_ADAPTER, CATALOG_REPOSITORY, CATALOG_SOURCE } from '../catalog/catalog.module';
import {
  IngestRunInProgressError,
  type CatalogRepository,
} from '../catalog/catalog-repository';
import { ingest, type IngestRunOutcome } from '../catalog/ingest';
import type { SkillSource } from '../catalog/skill-source';

/**
 * Resultado da tentativa: `started: false` é "já existe execução", o `409` da
 * rota. Um booleano + outcome opcional obrigaria quem chama a checar `undefined`;
 * a união discriminada torna o caso explícito no tipo.
 */
export type IngestAttempt =
  | { readonly started: true; readonly outcome: IngestRunOutcome }
  | { readonly started: false };

@Injectable()
export class IngestService {
  /** Execução em voo nesta réplica; `null` quando a ingestão está livre. */
  private inFlight: Promise<IngestRunOutcome> | null = null;

  constructor(
    @Inject(CATALOG_SOURCE) private readonly source: SkillSource,
    @Inject(CATALOG_REPOSITORY) private readonly repository: CatalogRepository,
    @Inject(CATALOG_ADAPTER) private readonly adapter: string,
  ) {}

  /** Há execução em voo nesta réplica? (diagnóstico e teste) */
  isRunning(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Roda o refresh das chaves dadas, ou devolve `{started: false}` se já houver
   * uma execução.
   *
   * A checagem e a marca da trava acontecem no **mesmo tick**: `ingest()` começa
   * a rodar de forma síncrona até o primeiro `await`, e `inFlight` é atribuído em
   * seguida — duas requisições não conseguem passar pelo `if` juntas.
   */
  async refresh(sourceKeys: readonly string[]): Promise<IngestAttempt> {
    if (this.inFlight !== null) {
      return { started: false };
    }

    const run = this.execute(sourceKeys);
    this.inFlight = run;

    try {
      return { started: true, outcome: await run };
    } catch (error) {
      if (error instanceof IngestRunInProgressError) {
        // Outro processo já tem o run `running` (lock do banco): o request
        // perdeu a corrida e merece 409, não 500.
        return { started: false };
      }
      throw error;
    } finally {
      // Libera também no caminho de erro: run `failed` não pode deixar a
      // ingestão travada para sempre.
      this.inFlight = null;
    }
  }

  private execute(sourceKeys: readonly string[]): Promise<IngestRunOutcome> {
    return ingest({
      source: this.source,
      repository: this.repository,
      adapter: this.adapter,
      startedAt: new Date(),
      keys: sourceKeys,
    });
  }
}
