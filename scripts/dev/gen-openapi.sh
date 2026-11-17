#!/usr/bin/env bash
# gen-openapi.sh — gera o openapi.yaml no espelho ext4 e copia de volta.
#
# Por que no espelho: o gerador instancia o AppModule, que importa o PrismaService,
# e o `@prisma/client` gerado só existe em ~/cloud-verify (o checkout Windows não
# tem). Rodar aqui evita "Module has no exported member 'PrismaClient'".
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIRROR="$HOME/cloud-verify"
OUT="$ROOT/.gen.log"
: > "$OUT"

rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' \
  "$ROOT/backend/" "$MIRROR/backend/" >>"$OUT" 2>&1
rsync -a "$ROOT/openapi.yaml" "$MIRROR/openapi.yaml" >>"$OUT" 2>&1

cd "$MIRROR/backend"
{
  pnpm openapi:generate
  echo "GEN_EXIT=$?"
  cp "$MIRROR/openapi.yaml" "$ROOT/openapi.yaml"
  echo "--- bloco SkillDetail.data_snapshot ---"
  grep -A5 'RFC 3339 UTC of the catalog snapshot the record' "$ROOT/openapi.yaml"
  echo "--- hash ---"
  sha256sum "$ROOT/openapi.yaml"
} >>"$OUT" 2>&1

echo DONE
