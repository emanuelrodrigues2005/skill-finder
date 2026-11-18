#!/usr/bin/env bash
# verify-log.sh — roda um escopo do verify.sh e grava num log para leitura.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESCOPO="${1:-}"
OUT="$ROOT/.verify-$ESCOPO.log"
: > "$OUT"
cd "$ROOT"
if [ -n "$ESCOPO" ]; then
  bash scripts/dev/verify.sh "$ESCOPO" >>"$OUT" 2>&1
else
  bash scripts/dev/verify.sh >>"$OUT" 2>&1
fi
echo "EXIT=$?" >>"$OUT"
echo DONE
