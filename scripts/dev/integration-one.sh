#!/usr/bin/env bash
# integration-one.sh — roda UM spec de integracao e mostra a mensagem de erro crua.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.integration-one.log"
: > "$OUT"
cd "$ROOT/backend"

TEST_DATABASE_URL="postgresql://skills:skills@127.0.0.1:55432/skills_test" \
  pnpm exec jest --config test/jest-integration.json "${1:-test/integration/catalog-rotation.spec.ts}" \
  >>"$OUT" 2>&1
echo "EXIT=$?" >>"$OUT"
echo DONE
