#!/usr/bin/env bash
# check-frontend.sh — typecheck + lint + testes + build do frontend, num log so.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.logs/frontend-check.log"
mkdir -p "$ROOT/.logs"
: > "$OUT"
cd "$ROOT"

echo "== typecheck ==" >>"$OUT"
pnpm --dir frontend typecheck >>"$OUT" 2>&1
echo "TYPECHECK=$?" >>"$OUT"

echo "== lint ==" >>"$OUT"
pnpm --dir frontend exec eslint . >>"$OUT" 2>&1
echo "LINT=$?" >>"$OUT"

echo "== test ==" >>"$OUT"
pnpm --dir frontend test >>"$OUT" 2>&1
echo "TEST=$?" >>"$OUT"

echo "== build ==" >>"$OUT"
pnpm --dir frontend build >>"$OUT" 2>&1
echo "BUILD=$?" >>"$OUT"

grep -E '^(TYPECHECK|LINT|TEST|BUILD)=|Test Files|Tests ' "$OUT" | tail -10
