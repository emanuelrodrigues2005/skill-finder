/**
 * Popula o catálogo a partir da fixture congelada (`make seed`).
 *
 * Por que existe: o contrato publica `POST /api/v1/admin/ingest`, mas o
 * controller que o serve mora em `contract-admin.module.ts`, importado **só**
 * pelo gerador do OpenAPI — o runtime não expõe a rota. Sem este script, um
 * stack recém-subido responde `503 SOURCE_UNAVAILABLE` (`cache_empty`) para
 * toda busca, e não há como popular o catálogo localmente.
 *
 * Roda **dentro** do container (`docker compose run --rm api-dev pnpm seed`):
 * o Postgres do compose não publica porta no host, e o `@prisma/client` gerado
 * só existe na imagem.
 *
 * O caminho da fixture é relativo ao diretório do pacote (`test/fixtures/...`),
 * por isso o alvo do Makefile monta `backend/test/fixtures` no container.
 */
import { PrismaClient } from '@prisma/client';

import { ingest } from '../src/catalog/ingest';
import { createFixtureSource, DEFAULT_FIXTURE_PATH } from '../src/catalog/fixture-source';
import { PrismaCatalogRepository } from '../src/catalog/prisma-catalog.repository';

async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const outcome = await ingest({
      source: createFixtureSource(),
      repository: new PrismaCatalogRepository(prisma),
      adapter: 'fixture',
      startedAt: new Date(),
    });

    console.log(
      `seed: status=${outcome.status} vistos=${outcome.items_seen} ` +
        `gravados=${outcome.items_upserted} desativados=${outcome.items_deactivated}` +
        (outcome.error_code === null ? '' : ` erro=${outcome.error_code}`),
    );

    if (outcome.status !== 'ok') {
      console.error(
        `seed: a ingestão não fechou como "ok" (ficheiro usado: ${DEFAULT_FIXTURE_PATH}).`,
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
