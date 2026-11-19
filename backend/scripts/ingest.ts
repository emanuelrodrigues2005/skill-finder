/**
 * Executa **um ciclo de ingestão do catálogo** (`make ingest`).
 *
 * Diferente do `seed.ts`, esta é a ingestão de produção: a fonte vem de
 * `SKILL_SOURCE_KIND` (com `html`, o skills.sh real a 1 req/s) e o ciclo é o do
 * **rodízio** — 720 chaves por execução, escolhidas por `planCycle` (hot → inéditas
 * → cold). É a peça que o agendador do deploy chama a cada 6 h.
 *
 * Por que existe (e por que não é a rota admin): `POST /api/v1/admin/ingest` aceita
 * 1–20 chaves e roda **dentro** do request — serve para refresh pontual de um
 * operador, não para o ciclo. Um cron precisa de um comando que rode o ciclo
 * inteiro e que **não** dependa de HTTP, e é isto.
 *
 * Roda dentro do container (`docker compose run --rm api-dev pnpm ingest`): o
 * Postgres do compose não publica porta no host e o `@prisma/client` gerado só
 * existe na imagem.
 *
 * Exemplo de agendamento (host ou EC2, F3/F4):
 *
 *     0 *\/6 * * *  cd /srv/skill-finder && \
 *       docker compose --profile prod run --rm api pnpm ingest >> /var/log/ingest.log 2>&1
 *
 * Saída: uma linha com o eco do `ingest_run`. `exit 1` **somente** quando o run
 * fecha `failed` — `partial` é um desfecho legítimo (a fonte entregou menos que o
 * ciclo pediu) e não deve acordar ninguém do mesmo jeito que uma falha de fonte.
 */
import { PrismaClient } from '@prisma/client';

import { ingest, type IngestRunOutcome } from '../src/catalog/ingest';
import type { CatalogRepository } from '../src/catalog/catalog-repository';
import { createSource } from '../src/catalog/catalog.module';
import { PrismaCatalogRepository } from '../src/catalog/prisma-catalog.repository';
import type { SkillSource } from '../src/catalog/skill-source';
import { loadEnv } from '../src/config/env.schema';

/** O que o ciclo precisa; injetado para o teste não tocar em rede nem em banco. */
export interface IngestCliDeps {
  readonly source: SkillSource;
  readonly repository: CatalogRepository;
  /** Vai para `ingest_run.adapter` (`html` ou `fixture`). */
  readonly adapter: string;
  /** Relógio injetado; padrão o real. */
  readonly now?: () => Date;
}

/**
 * Roda **um** ciclo de rodízio.
 *
 * Sem `keys`: é o rodízio que escolhe a fatia (720), incluindo a cota de
 * descoberta — passar chaves explícitas é o caminho do admin, não do agendador.
 */
export async function runIngest(deps: IngestCliDeps): Promise<IngestRunOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  return ingest({
    source: deps.source,
    repository: deps.repository,
    adapter: deps.adapter,
    startedAt: now(),
  });
}

/** Linha única de log — o cron não guarda estrutura, guarda texto. */
export function describeOutcome(outcome: IngestRunOutcome): string {
  return (
    `ingest: status=${outcome.status} pedidas=${outcome.items_requested} ` +
    `vistas=${outcome.items_seen} gravadas=${outcome.items_upserted} ` +
    `desativadas=${outcome.items_deactivated}` +
    (outcome.error_code === null ? '' : ` erro=${outcome.error_code}`)
  );
}

async function main(): Promise<void> {
  // `loadEnv` valida o ambiente do mesmo jeito que a API: um ciclo que roda com
  // configuração inválida falha **aqui**, não no meio de 720 requisições.
  const env = loadEnv(process.env);

  if (env.skillSourceKind === 'fixture') {
    // Aviso alto: em produção isto ingere as 25 skills de teste. Quem agenda tem
    // de saber que o ciclo não vai tocar o skills.sh.
    console.warn(
      'ingest: SKILL_SOURCE_KIND=fixture — este ciclo usa a fixture de teste, não o ' +
        'skills.sh. Para o catálogo real, defina SKILL_SOURCE_KIND=html.',
    );
  }

  const prisma = new PrismaClient();

  try {
    const outcome = await runIngest({
      source: createSource({
        adapter: env.skillSourceKind,
        baseUrl: env.skillSourceBaseUrl,
        rps: env.skillSourceRps,
      }),
      repository: new PrismaCatalogRepository(prisma),
      adapter: env.skillSourceKind,
    });

    console.log(describeOutcome(outcome));

    if (outcome.status === 'failed') {
      // `partial` não vira exit 1: significa "a fonte entregou menos que o pedido",
      // e o run já registra `LOW_CYCLE_COVERAGE`. Só `failed` é chamado para alarme.
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

/* istanbul ignore next — o `main` só roda como comando; a lógica testável está em `runIngest`. */
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
