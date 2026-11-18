#!/usr/bin/env bash
# jest-one.sh — roda um spec no espelho ext4 e grava a saida num log.
# Uso: bash scripts/dev/jest-one.sh test/unit/llm-cache.spec.ts
#
# O `rsync --delete` aponta para um caminho COMPUTADO. O gate do AGENTS.md exige
# imprimir o destino resolvido e conferir que ele esta dentro do alvo esperado
# antes de apagar qualquer coisa — foi o achado do parecer de seguranca.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC="${1:?informe o caminho do spec}"
OUT="$ROOT/.jest-one.log"
DEST="$HOME/cloud-verify/backend"

# Guarda: o destino tem de existir como diretorio e terminar em /cloud-verify/backend.
DEST_REAL="$(readlink -f "$DEST" 2>/dev/null || true)"
if [ -z "$DEST_REAL" ] || [ ! -d "$DEST_REAL" ]; then
  echo "ABORTADO: destino do espelho nao existe ($DEST)." >&2
  exit 2
fi
case "$DEST_REAL" in
  */cloud-verify/backend) ;;
  *)
    echo "ABORTADO: destino fora do esperado: $DEST_REAL" >&2
    exit 2
    ;;
esac
echo "espelho: $DEST_REAL"

: > "$OUT"
rsync -a --delete --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' \
  "$ROOT/backend/" "$DEST_REAL/" >>"$OUT" 2>&1
rsync -a "$ROOT/openapi.yaml" "$DEST_REAL/../openapi.yaml" >>"$OUT" 2>&1

cd "$DEST_REAL"
pnpm exec jest "$SPEC" --verbose >>"$OUT" 2>&1
echo "EXIT=$?" >>"$OUT"
echo DONE
