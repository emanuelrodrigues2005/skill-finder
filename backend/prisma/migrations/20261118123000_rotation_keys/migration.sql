-- Rodízio do catálogo — issue #45 (F2.10 / D3).
--
-- Gerado com `prisma migrate diff` contra o Postgres de teste (porta 55432) e
-- revisado à mão, como manda `prisma/migrations/README.md` §Drift: o diff vinha
-- com `DROP INDEX "skill_search_doc_idx"`, que é drift do índice GIN manual da
-- migration inicial e **não** pode entrar no arquivo.
--
-- `items_requested` é nullable de propósito: run antigo, e o run que está em
-- curso, não têm esse número. Dado ausente é NULL, nunca zero (AGENTS.md
-- regra 3).
--
-- O índice `(is_active, last_seen_at)` é o que sustenta a consulta do cold set
-- de `selectRotationKeys` (20.000 linhas ativas a cada ciclo de 6 h). Não é
-- parcial: `is_active` é a primeira coluna do par, o que dá o mesmo benefício
-- sem depender de predicado parcial que o Prisma não expressa.

-- AlterTable
ALTER TABLE "ingest_run" ADD COLUMN     "items_requested" INTEGER;

-- CreateIndex
CREATE INDEX "skill_is_active_last_seen_at_idx" ON "skill"("is_active", "last_seen_at");
