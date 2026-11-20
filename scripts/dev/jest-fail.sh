#!/usr/bin/env bash
# jest-fail.sh — roda um spec e mostra so as falhas, gravando num log.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.logs/jest-fail.log"
mkdir -p "$(dirname "$OUT")"
: > "$OUT"
DEST="$HOME/cloud-verify/backend"
rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' \
  "$ROOT/backend/" "$DEST/" >>"$OUT" 2>&1
rsync -a "$ROOT/openapi.yaml" "$DEST/../openapi.yaml" >>"$OUT" 2>&1
cd "$DEST"
pnpm exec jest "${1:-}" --verbose >>"$OUT" 2>&1
echo "EXIT=$?" >>"$OUT"
echo DONE
