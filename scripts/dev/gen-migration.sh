#!/usr/bin/env bash
# gen-migration.sh — gera a migration inicial do Prisma contra o Postgres
# temporario (sf-migrate, porta 55432) sem tocar no compose do projeto.
#
# Usa --create-only: o DDL base vem do schema.prisma; o SQL manual (pg_trgm,
# indices GIN, CHECKs, lock de ingest_run) e apensado depois pelo orquestrador.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.gen-migration.log"
export DATABASE_URL='postgresql://skills:migrate@127.0.0.1:5432/skills?schema=public'
: > "$OUT"

cd "$ROOT/backend"

{
  echo "=== prisma migrate dev --create-only --name init ==="
  pnpm exec prisma migrate dev --create-only --name init --skip-generate
  echo "EXIT=$?"
  echo
  echo "=== migrations criadas ==="
  ls -1 prisma/migrations/
} >>"$OUT" 2>&1

echo DONE
