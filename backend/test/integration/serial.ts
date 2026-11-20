/**
 * Serialização do banco de teste entre **arquivos** de spec (issue #12).
 *
 * `jest-integration.json` roda com `maxWorkers: 1`, então o nível de integração
 * sozinho não tem concorrência entre arquivos. Mas `jest-cov.json` (o alvo
 * `make test-coverage`) roda os três níveis no mesmo passe e **não** fixa
 * workers: o Jest usa `cpus - 1` workers por padrão. Dois specs de integração em
 * workers diferentes compartilham o mesmo Postgres em 127.0.0.1:55432, e o
 * `truncateAll` de um apagaria as linhas que o outro acabou de ingerir no meio
 * de uma asserção — um verde/vermelho que depende de agendamento, isto é, o pior
 * tipo de teste.
 *
 * A trava é um **advisory lock** do Postgres (`pg_try_advisory_lock`), não um
 * arquivo: quem manda é o banco, então o mesmo mecanismo vale para dois
 * processos de Jest e para dois agentes rodando a suíte ao mesmo tempo.
 *
 * `connection_limit=1` é o que torna a trava confiável: um advisory lock de
 * sessão pertence à conexão que o pegou, e o `unlock` tem de sair pela **mesma**
 * conexão. Com o pool de uma conexão só, toda query do cliente de teste usa a
 * mesma sessão — sem isso o `pg_advisory_unlock` poderia cair em outra conexão e
 * a trava ficaria presa até o fim do processo.
 *
 * Uso esperado:
 *
 * ```ts
 * const prisma = createTestPrismaClient(serializedTestDatabaseUrl());
 * beforeAll(async () => { await assertDatabase(prisma); await lockTestDatabase(prisma); }, 120_000);
 * afterAll(async () => { await unlockTestDatabase(prisma); await prisma.$disconnect(); });
 * ```
 */
import type { PrismaClient } from '@prisma/client';

import { testDatabaseUrl } from './db';

/**
 * Chave do advisory lock. Constante e improvável: qualquer outro cliente que
 * pegue `pg_advisory_lock(12554320)` neste banco entra na mesma fila — que é o
 * que se quer, porque o banco de teste é descartável e tem um dono só.
 */
const LOCK_KEY = 12_554_320n;

/** Intervalo entre tentativas de pegar a trava. */
const RETRY_MS = 50;

/**
 * URL do banco de teste com pool de **uma** conexão, para que o advisory lock de
 * sessão sobreviva entre as queries do spec.
 */
export function serializedTestDatabaseUrl(url: string = testDatabaseUrl()): string {
  if (/[?&]connection_limit=/.test(url)) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=1`;
}

/**
 * Espera a vez de usar o banco. Nunca desiste em silêncio: estourado o prazo, o
 * erro diz que outro spec de integração segurou a trava — não é "banco fora".
 *
 * O prazo é largo de propósito: em `make test-coverage` os dois specs de
 * integração podem cair em workers diferentes e, no checkout em `/mnt/c` (9p),
 * um deles sozinho leva minutos. Prazo curto aqui viraria um vermelho que fala
 * de contenção quando o problema é só o sistema de arquivos.
 */
export async function lockTestDatabase(client: PrismaClient, waitMs = 600_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rows = await client.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
    `;
    if (rows[0]?.locked === true) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `nao consegui a trava do banco de teste em ${waitMs} ms: outro spec de integracao ` +
          'segurou o advisory lock. Banco ausente e outra mensagem (db.ts) — esta e contencao.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}

/** Devolve a vez. Deve rodar antes do `$disconnect` do cliente que pegou a trava. */
export async function unlockTestDatabase(client: PrismaClient): Promise<void> {
  await client.$queryRaw`SELECT pg_advisory_unlock(${LOCK_KEY})`;
}
