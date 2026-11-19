#!/usr/bin/env bash
# check-backend.sh — typecheck + lint + cadeia completa, num log so.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.logs/backend-check.log"
mkdir -p "$ROOT/.logs"
: > "$OUT"
cd "$ROOT"

echo "== typecheck ==" >>"$OUT"
pnpm --dir backend typecheck >>"$OUT" 2>&1
echo "TYPECHECK=$?" >>"$OUT"

echo "== lint ==" >>"$OUT"
pnpm --dir backend lint >>"$OUT" 2>&1
echo "LINT=$?" >>"$OUT"

echo "== verify.sh ==" >>"$OUT"
bash scripts/dev/verify.sh >>"$OUT" 2>&1
echo "VERIFY=$?" >>"$OUT"

grep -E '^(TYPECHECK|LINT|VERIFY)=|FALHAS=' "$OUT" | tail -6
