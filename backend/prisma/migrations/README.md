Prisma não gera migration sem banco: rode `pnpm --dir backend prisma:migrate -- --name init` com o Postgres do compose no ar.

Depois de gerado o `migration.sql` da init, acrescente o SQL que o Prisma Schema
não expressa. **A ordem importa**: a extension antes dos índices que usam o
operator class dela, senão a primeira migration aborta com
`operator class "gin_trgm_ops" does not exist`.

```sql
-- 1. extension antes de qualquer índice que dependa dela
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. busca lexical (§4.1): GIN por similaridade no nome e GIN no tsvector
CREATE INDEX "skill_name_trgm_idx" ON "skill" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "skill_search_doc_idx" ON "skill" USING GIN ("search_doc");

-- 3. métricas nunca negativas: ausente é NULL, jamais zero (§4.1)
ALTER TABLE "skill" ADD CONSTRAINT "skill_stars_non_negative"
  CHECK ("stars" IS NULL OR "stars" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_installs_non_negative"
  CHECK ("installs" IS NULL OR "installs" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_vulns_non_negative"
  CHECK ("vulnerability_count" IS NULL OR "vulnerability_count" >= 0);

-- 4. lock da ingestão: no máximo uma execução `running` (§4.1)
CREATE UNIQUE INDEX "ingest_run_running_key" ON "ingest_run" ("status")
  WHERE "status" = 'running';
```
