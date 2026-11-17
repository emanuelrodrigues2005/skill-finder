import { PrismaClient } from '@prisma/client';

/**
 * Harness do nível de **integração** — issue #12, fase 2.
 *
 * Banco real, mas nunca o de produção e nunca aberto pelo Jest a partir do
 * `make`: quem sobe o container é o alvo `make db-test-up` (porta **55432**, para
 * não colidir com a 5432 do compose). O Jest só consome uma URL já disponível —
 * por isso `assertDatabase` **lança** em vez de pular: banco ausente é vermelho,
 * não verde.
 *
 * Por que a porta 55432 e não a 5432: o compose de dev pode estar de pé com o
 * Postgres de desenvolvimento; um `TRUNCATE` acidental nele apagaria dado de
 * quem está trabalhando. O banco de teste é descartável e tem nome próprio
 * (`skills_test`), visível no `docker ps`.
 *
 * Uso esperado num spec de integração:
 *
 * ```ts
 * import { assertDatabase, createTestPrismaClient, truncateAll } from './db';
 *
 * const prisma = createTestPrismaClient();
 *
 * beforeAll(async () => {
 *   await assertDatabase(prisma);
 * });
 * beforeEach(async () => {
 *   await truncateAll(prisma);
 * });
 * afterAll(async () => {
 *   await prisma.$disconnect();
 * });
 * ```
 *
 * `nock.disableNetConnect()` (em `test/setup.ts`) não atrapalha: ele intercepta
 * `http(s)`, e o `pg` abre `net.Socket` cru. O que impede um banco externo é a
 * guarda de loopback abaixo — a mesma da fase 1 para `DATABASE_URL`.
 */

/**
 * Default do harness. O `Makefile` exporta a mesma URL em `make test-integration`
 * via `TEST_DATABASE_URL`; este default existe para que `pnpm test:integration`
 * sozinho aponte para o mesmo lugar em vez de falhar por variável ausente.
 *
 * Credencial de teste, não segredo: o container escuta só em 127.0.0.1 e o
 * volume é descartável (`make db-test-down`).
 */
export const TEST_DATABASE_URL_DEFAULT = 'postgresql://skills:skills@127.0.0.1:55432/skills_test';

/** Loopback exato, nunca `includes` — `localhost.exemplo.invalido` também contém "localhost". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface TestDatabaseTarget {
  /** URL efetiva, sem alterações. */
  url: string;
  hostname: string;
  port: string;
  database: string;
}

/**
 * Resolve e valida `TEST_DATABASE_URL` (ou o default). Lança se a URL for
 * inválida ou se o host não for loopback: os testes não abrem socket externo
 * (AGENTS.md regra 5), e um valor exportado no shell não pode virar um teste
 * contra o banco de produção.
 */
export function testDatabaseTarget(): TestDatabaseTarget {
  const url = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL_DEFAULT;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      'TEST_DATABASE_URL nao e uma URL valida. ' +
        'Formato: postgresql://usuario:senha@127.0.0.1:55432/skills_test',
    );
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `TEST_DATABASE_URL usa o protocolo "${parsed.protocol}", que nao e Postgres. ` +
        'Use postgresql:// (o Prisma nao aceita sufixo de driver como +psycopg).',
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) {
    // A mensagem cita o host, nunca a URL inteira: a senha nao pode ir para o log do CI.
    throw new Error(
      `TEST_DATABASE_URL aponta para "${hostname}", que nao e loopback. ` +
        'Os testes nao abrem socket externo (AGENTS.md regra 5): use 127.0.0.1, localhost ou ::1.',
    );
  }

  return {
    url,
    hostname,
    port: parsed.port === '' ? '5432' : parsed.port,
    database:
      parsed.pathname.replace(/^\//, '') === '' ? '(padrao)' : parsed.pathname.replace(/^\//, ''),
  };
}

/** Atalho para a URL crua — o que `PrismaClient` e o `make migrate-test` precisam. */
export function testDatabaseUrl(): string {
  return testDatabaseTarget().url;
}

/**
 * `PrismaClient` apontado para o banco de teste. `datasourceUrl` vence o
 * `DATABASE_URL` do schema, então o client de teste nunca depende do `.env`.
 */
export function createTestPrismaClient(url: string = testDatabaseUrl()): PrismaClient {
  return new PrismaClient({ datasourceUrl: url });
}

/**
 * Código do erro do Prisma, sem o texto: `P1001` (banco inalcançável) já diz o
 * que é, e a mensagem original pode ecoar a URL com senha. Erros de inicialização
 * (`PrismaClientInitializationError`) carregam o código em `errorCode`; os de
 * requisição, em `code`. No Prisma 6.2 o `errorCode` desse erro vem `undefined`
 * e a `message` vem vazia — por isso o nome do erro é o último recurso.
 */
function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return 'sem codigo';
  }
  const { errorCode, code, name } = error as {
    errorCode?: unknown;
    code?: unknown;
    name?: unknown;
  };
  for (const candidate of [errorCode, code, name]) {
    if (typeof candidate === 'string' && candidate !== '') {
      return candidate;
    }
  }
  return 'sem codigo';
}

/**
 * Prova que o banco responde antes do primeiro caso. Falhar aqui é **vermelho**:
 * a alternativa (pular a suíte quando o banco falta) devolveria verde para uma
 * integração que nunca rodou.
 */
export async function assertDatabase(client: PrismaClient): Promise<void> {
  try {
    await client.$queryRaw`SELECT 1`;
  } catch (error) {
    const target = testDatabaseTarget();
    throw new Error(
      `banco de teste inalcancavel em ${target.hostname}:${target.port}/${target.database} ` +
        `[${errorCodeOf(error)}]. Rode 'make db-test-up' e 'make migrate-test' antes de ` +
        "'make test-integration'. Integracao nao pula: banco ausente e vermelho, nunca verde.",
      { cause: error },
    );
  }
}

/** Aspas de identificador SQL; nomes vêm de `pg_tables`, não do usuário. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Limpa o banco entre casos, mantendo o schema: `TRUNCATE ... RESTART IDENTITY
 * CASCADE` em todas as tabelas de `public`, menos `_prisma_migrations` (apagá-la
 * faria o `migrate deploy` reaplicar migrations já aplicadas).
 *
 * `TRUNCATE` não é expressável pelo `deleteMany`, e `CASCADE` resolve a ordem das
 * FKs sem o teste precisar conhecê-la.
 */
export async function truncateAll(client: PrismaClient): Promise<void> {
  const rows = await client.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename <> '_prisma_migrations'
     ORDER BY tablename
  `;

  if (rows.length === 0) {
    return;
  }

  const tables = rows.map((row) => `"public".${quoteIdentifier(row.tablename)}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}
