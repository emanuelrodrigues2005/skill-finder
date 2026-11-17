#!/usr/bin/env bash
# fe-test.sh — roda a suite do frontend e grava a saida num arquivo, para o
# orquestrador ler sem depender do stdout do wsl.exe (que trunca em comandos
# longos e mutila padroes com pipe/caracteres especiais).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.fe-test.log"
: > "$OUT"

cd "$ROOT/frontend"
pnpm test >>"$OUT" 2>&1
echo "EXIT=$?" >>"$OUT"
echo DONE
