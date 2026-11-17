import { testDatabaseUrl } from './db';

/**
 * Primeiro `setupFilesAfterEnv` do nível de integração (antes de `test/setup.ts`).
 *
 * Alinha **as duas** variáveis de banco numa só fonte de verdade:
 * - `TEST_DATABASE_URL` é o que `db.ts` usa para o `PrismaClient` de teste;
 * - `DATABASE_URL` é o que o schema do Prisma e o `env.schema.ts` leem — uma
 *   integração que sobe a aplicação inteira usaria a 5432 do compose (ou o
 *   default de `test/setup.ts`) sem esta linha, e o teste passaria a medir outro
 *   banco sem avisar.
 *
 * `testDatabaseUrl()` valida loopback e **lança** fora dele; aqui isso é desejado:
 * a suíte inteira fica vermelha na carga, com a mensagem certa, em vez de abrir
 * socket externo. `test/setup.ts` roda logo depois e revalida `DATABASE_URL`.
 */
const url = testDatabaseUrl();

process.env.TEST_DATABASE_URL = url;
process.env.DATABASE_URL = url;
