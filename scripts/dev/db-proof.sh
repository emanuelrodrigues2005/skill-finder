#!/usr/bin/env bash
# db-proof.sh — provas de banco que a migration precisa entregar, tudo numa
# invocacao (o container descartavel nao sobrevive entre execucoes).
# Ordem: provas de DDL primeiro; a sonda do Prisma por ultimo, porque e ela que
# derruba o container.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.logs/db-proof.log"
mkdir -p "$(dirname "$OUT")"
export DATABASE_URL='postgresql://skills:migrate@127.0.0.1:5432/skills?schema=public'
PSQL() { docker exec sf-migrate psql -U skills -d skills -tAc "$1" 2>&1; }
: > "$OUT"

docker rm -f sf-migrate >/dev/null 2>&1
docker run -d --name sf-migrate --network host \
  -e POSTGRES_PASSWORD=migrate -e POSTGRES_USER=skills -e POSTGRES_DB=skills \
  postgres:16-alpine >/dev/null 2>&1
for i in $(seq 1 40); do docker exec sf-migrate pg_isready -U skills -d skills >/dev/null 2>&1 && break; sleep 1; done

cd "$ROOT/backend"
{
  echo "=== deploy ==="
  pnpm exec prisma migrate deploy 2>&1 | grep -E 'applied|pending|Error' | head -3

  echo
  echo "=== 1. estrutura ==="
  PSQL "select 'tables=' || count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
  PSQL "select 'idx=' || string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname='public' and indexname in ('skill_search_doc_idx','skill_name_trgm_idx','ingest_run_running_key','skill_source_key_key')"

  echo
  echo "=== 2. lock de ingestao: dois running ==="
  PSQL "insert into ingest_run (adapter, status, started_at) values ('fixture','running', now()) returning 'run1 running inserido'"
  PSQL "insert into ingest_run (adapter, status, started_at) values ('fixture','running', now())"
  PSQL "insert into ingest_run (adapter, status, started_at, finished_at) values ('fixture','ok', now(), now()) returning 'run ok coexistindo'"

  echo
  echo "=== 3. CHECK de metrica negativa ==="
  PSQL "insert into skill (source_key, name, source_url, first_seen_at, last_seen_at, stars) values ('a/b/c','x','https://x.test/a', now(), now(), -1)"
  PSQL "insert into skill (source_key, name, source_url, first_seen_at, last_seen_at, stars) values ('a/b/c','x','https://x.test/a', now(), now(), 0) returning 'stars=0 aceito'"
  PSQL "select 'stars_no_banco=' || coalesce(stars::text,'NULL') from skill where source_key='a/b/c'"

  echo
  echo "=== 4. UNIQUE de source_key (idempotencia) ==="
  PSQL "insert into skill (source_key, name, source_url, first_seen_at, last_seen_at) values ('a/b/c','outro','https://x.test/b', now(), now())"

  echo
  echo "=== 5. upsert ON CONFLICT com search_doc (o que a #7 vai rodar) ==="
  PSQL "insert into skill (source_key, name, source_url, first_seen_at, last_seen_at, stars, search_doc) values ('a/b/c','Renomeada','https://x.test/a', now(), now(), 42, to_tsvector('english','renomeada')) on conflict (source_key) do update set name = excluded.name, stars = excluded.stars, search_doc = excluded.search_doc returning 'upsert ok: ' || name || ' stars=' || stars"
  PSQL "select 'linhas=' || count(*) from skill where source_key='a/b/c'"
  PSQL "select 'fts=' || count(*) from skill where search_doc @@ to_tsquery('english','renomeada')"

  echo
  echo "=== 6. pg_trgm (fallback de similaridade) ==="
  PSQL "select 'similarity=' || round(similarity('kubernets','kubernetes')::numeric, 3)"

  echo
  echo "=== 7. sonda de drift (o Prisma quer dropar os GIN manuais?) ==="
  pnpm exec prisma migrate dev --create-only --name probe_drift --skip-generate >/dev/null 2>&1
  PROBE=$(ls -1d prisma/migrations/*_probe_drift 2>/dev/null | head -1)
  if [ -n "$PROBE" ]; then cat "$PROBE/migration.sql"; else echo "sonda nao gerada"; fi
  rm -rf prisma/migrations/*_probe_drift
  echo "sonda removida; migrations: $(ls -1 prisma/migrations/ | tr '\n' ' ')"

  echo
  echo "=== estado do container no fim ==="
  docker ps --filter name=sf-migrate --format '{{.Status}}' || true
} >>"$OUT" 2>&1

echo DONE
