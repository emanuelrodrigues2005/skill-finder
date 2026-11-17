# Migrations

O DDL base vem do `schema.prisma`; o que o PSL **não expressa** é apensado à mão no
`migration.sql`. Este arquivo registra as duas armadilhas que custaram uma sessão
inteira de diagnóstico.

## Como gerar

```bash
# com o Postgres no ar (make up, ou um container descartável com a porta publicada)
pnpm --dir backend prisma:migrate -- --create-only --name <nome>
# revisar o SQL gerado e apensar o bloco manual abaixo
pnpm --dir backend prisma:deploy
pnpm --dir backend prisma:generate
```

`--create-only` **não aplica** nada: ele só escreve o arquivo. É obrigatório
revisar antes de aplicar.

## O bloco manual e a ordem

A ordem importa: a extensão vem **antes** dos índices que usam o operator class
dela, senão a migration aborta com `operator class "gin_trgm_ops" does not exist`.

```sql
-- 1. extensão antes de qualquer índice que dependa dela
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. busca lexical (§6.4): GIN no tsvector e GIN por similaridade no nome
CREATE INDEX "skill_search_doc_idx" ON "skill" USING GIN ("search_doc");
CREATE INDEX "skill_name_trgm_idx" ON "skill" USING GIN ("name" gin_trgm_ops);

-- 3. métrica é ausente (NULL) ou não-negativa; nunca zero nem negativo (§regra 3)
ALTER TABLE "skill" ADD CONSTRAINT "skill_stars_non_negative"
  CHECK ("stars" IS NULL OR "stars" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_installs_non_negative"
  CHECK ("installs" IS NULL OR "installs" >= 0);
ALTER TABLE "skill" ADD CONSTRAINT "skill_vulnerability_count_non_negative"
  CHECK ("vulnerability_count" IS NULL OR "vulnerability_count" >= 0);

-- 4. lock da ingestão: no máximo um run em `running` (§7.3)
CREATE UNIQUE INDEX "ingest_run_running_key" ON "ingest_run" ("status")
  WHERE "status" = 'running';
```

**Não** acrescente `CHECK` de enum: os tipos nativos já garantem, e duplicar cria
duas fontes de verdade que precisam ser alteradas juntas. **Não** use
`CREATE INDEX CONCURRENTLY`: o Prisma aplica cada migration em transação e o
comando aborta.

## ⚠️ Drift: o Prisma quer dropar o SQL manual

Verificado nesta máquina (2026-11-17) com a sonda
`prisma migrate dev --create-only --name probe_drift` logo após aplicar a init:

```sql
-- DropIndex
DROP INDEX "skill_name_trgm_idx";

-- DropIndex
DROP INDEX "skill_search_doc_idx";
```

O Prisma não modela `search_doc` (é `Unsupported("tsvector")`) nem o índice
`gin_trgm_ops`, então a **próxima** migration gerada por `migrate dev` derrubaria
os dois índices em silêncio — a busca degradaria sem nenhum erro.

Regras que decorrem disso:

1. **Sempre** `--create-only` e revisar o SQL antes de aplicar.
2. Se a sonda ou o SQL gerado contiver `DROP INDEX`/`DROP CONSTRAINT` para os
   objetos manuais, **remova essas linhas** do arquivo antes de commitar.
3. Para mudanças futuras, preferir `prisma migrate diff` (gera o diff sem aplicar)
   a `migrate dev`, que recria o histórico.
4. O gate de CI da F4 deve rodar a sonda e falhar se ela vier suja.

## Evidência de que a init está correta

Rodado contra um `postgres:16-alpine` limpo (container descartável, porta 5432):

| Prova | Resultado |
| --- | --- |
| `migrate deploy` 1ª vez | `All migrations have been successfully applied` |
| `migrate deploy` 2ª vez | `No pending migrations to apply` (idempotente) |
| Tabelas | 8 |
| Índices | `skill_source_key_key`, `skill_search_doc_idx`, `skill_name_trgm_idx`, `ingest_run_running_key` |
| `pg_trgm` | instalado; `similarity('kubernets','kubernetes') = 0.615` |
| Lock de ingestão | 2º `running` rejeitado por `ingest_run_running_key`; `ok` coexiste |
| `CHECK` de métrica | `stars = -1` rejeitado; `stars = 0` aceito |
| `UNIQUE (source_key)` | duplicata rejeitada |
| Upsert da ingestão | `ON CONFLICT (source_key) DO UPDATE` grava `search_doc` e o FTS acha (`search_doc @@ to_tsquery`) |
