#!/usr/bin/env bash
# cov-check.sh — roda a cobertura no espelho ext4e mostra o resumo por diretorio.
# Existe porque o job `test-unit` do CI roda `test:cov` e reprova no LIMIAR, nao
# nos testes: 545 verdes ainda podem falhar se um diretorio cair abaixo de 80%.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.cov-check.log"
: > "$OUT"
DEST="$HOME/cloud-verify/backend"

DEST_REAL="$(readlink -f "$DEST" 2>/dev/null || true)"
case "${DEST_REAL:-}" in
  */cloud-verify/backend) ;;
  *) echo "ABORTADO: destino inesperado: ${DEST_REAL:-vazio}" >&2; exit 2 ;;
esac

rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' \
  "$ROOT/backend/" "$DEST_REAL/" >>"$OUT" 2>&1
rsync -a "$ROOT/openapi.yaml" "$DEST_REAL/../openapi.yaml" >>"$OUT" 2>&1

cd "$DEST_REAL"
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --config test/jest-cov.json --coverageReporters=text >>"$OUT" 2>&1
echo "EXIT=$?" >>"$OUT"
echo DONE
