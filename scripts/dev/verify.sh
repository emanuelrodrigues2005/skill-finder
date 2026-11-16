#!/usr/bin/env bash
# verify.sh — cadeia de verificação do backend (issue por issue).
#
# Uso:
#   wsl.exe -e bash -lc 'cd /mnt/c/Users/Lima02/Documents/bcc/cloud && bash scripts/dev/verify.sh'
#   bash scripts/dev/verify.sh openapi      # só o contrato
#   bash scripts/dev/verify.sh e2e          # só o e2e
#
# Grava tudo em .verify.log (raiz do repo) e imprime o resumo no fim. Existe porque
# comando inline com `{ }` e `$?` quebra no wrapper do harness.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID=$(date +%Y%m%d-%H%M%S)-$$
LOG="$ROOT/.verify-$RUN_ID.log"
cd "$ROOT"

scope="${1:-all}"
: > "$LOG"

run() {
  local label="$1"; shift
  echo "=== $label ===" | tee -a "$LOG"
  "$@" >> "$LOG" 2>&1
  local code=$?
  echo "EXIT[$label]=$code" | tee -a "$LOG"
  return $code
}

fails=0

if [ "$scope" = "all" ] || [ "$scope" = "typecheck" ]; then
  run TYPECHECK pnpm --dir backend typecheck || fails=$((fails + 1))
fi

if [ "$scope" = "all" ] || [ "$scope" = "openapi" ]; then
  run CONTRATO pnpm --dir backend test openapi || fails=$((fails + 1))
fi

if [ "$scope" = "all" ] || [ "$scope" = "unit" ]; then
  run SUITE pnpm --dir backend test || fails=$((fails + 1))
fi

if [ "$scope" = "e2e" ] || [ "$scope" = "all" ]; then
  run E2E pnpm --dir backend test:e2e || fails=$((fails + 1))
fi

echo "" | tee -a "$LOG"
echo "=== RESUMO ===" | tee -a "$LOG"
grep -E '^(EXIT\[|Tests:|Test Suites:)' "$LOG" | tee -a "$LOG"
echo "FALHAS=$fails" | tee -a "$LOG"
echo "log completo: $LOG"
exit "$fails"
