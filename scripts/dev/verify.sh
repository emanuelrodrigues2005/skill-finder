#!/usr/bin/env bash
# verify.sh — cadeia de verificação do backend, rodando numa CÓPIA EM EXT4.
#
# Por que a cópia: o checkout vive em /mnt/c, que no WSL é 9p — cada leitura de
# arquivo atravessa a ponte com o Windows. Medido neste projeto (65.681 arquivos
# em node_modules): `jest --listTests` leva 124 s e uma suíte de 4 testes leva
# 451 s em /mnt/c, contra 5,5 s da mesma suíte em ext4. 95% do tempo era espera
# de I/O, não CPU. Isso é o que fazia cada rodada de verificação custar ~15 min.
#
# O checkout continua sendo a fonte de verdade (é onde o editor trabalha): este
# script espelha backend/ para $HOME/cloud-verify/backend a cada execução e roda
# lá. Nada é escrito no checkout, exceto o log final.
#
# Uso:
#   bash scripts/dev/verify.sh              # typecheck + contrato + suíte + e2e
#   bash scripts/dev/verify.sh openapi      # só o contrato
#   bash scripts/dev/verify.sh docs         # só o e2e de docs
#   bash scripts/dev/verify.sh --native     # roda no /mnt/c (lento, para comparar)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIRROR="$HOME/cloud-verify"
SCOPE="all"

for arg in "$@"; do
  case "$arg" in
    --native) MIRROR="" ;;
    *) SCOPE="$arg" ;;
  esac
done

if [ -n "$MIRROR" ]; then
  mkdir -p "$MIRROR"
  # --delete mantém o espelho fiel; exclui o que é gerado (e o que é caro copiar).
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude coverage --exclude '*.log' \
    "$ROOT/backend/" "$MIRROR/backend/" || { echo "rsync falhou"; exit 1; }
  # `openapi.yaml` mora na RAIZ do monorepo e os testes o leem como
  # `../../openapi.yaml` a partir de backend/test: sem esta cópia, três casos de
  # contrato falham por ENOENT e o vermelho mente sobre o código.
  rsync -a "$ROOT/openapi.yaml" "$MIRROR/openapi.yaml" 2>/dev/null \
    || { echo "openapi.yaml ausente na raiz"; exit 1; }
  WORK="$MIRROR/backend"
  LABEL="ext4 ($MIRROR/backend)"
else
  WORK="$ROOT/backend"
  LABEL="/mnt/c (9p, lento)"
fi

cd "$WORK"
LOG="$WORK/.verify.log"
: > "$LOG"

if [ ! -d node_modules ]; then
  echo "instalando dependências em $LABEL (uma vez)..." | tee -a "$LOG"
  pnpm install --frozen-lockfile >>"$LOG" 2>&1 || { tail -20 "$LOG"; exit 1; }
fi

run() {
  local label="$1"; shift
  local start end
  start=$(date +%s)
  echo "=== $label ===" | tee -a "$LOG"
  "$@" >>"$LOG" 2>&1
  local code=$?
  end=$(date +%s)
  echo "EXIT[$label]=$code  ($((end - start))s)" | tee -a "$LOG"
  return $code
}

fails=0

case "$SCOPE" in
  all)
    run TYPECHECK pnpm typecheck || fails=$((fails + 1))
    run CONTRATO pnpm test openapi || fails=$((fails + 1))
    run SUITE pnpm test || fails=$((fails + 1))
    run E2E pnpm test:e2e || fails=$((fails + 1))
    ;;
  typecheck) run TYPECHECK pnpm typecheck || fails=$((fails + 1)) ;;
  openapi)   run CONTRATO pnpm test openapi || fails=$((fails + 1)) ;;
  unit)      run SUITE pnpm test || fails=$((fails + 1)) ;;
  e2e)       run E2E pnpm test:e2e || fails=$((fails + 1)) ;;
  docs)      run DOCS pnpm test:e2e -- docs || fails=$((fails + 1)) ;;
  *) echo "escopo desconhecido: $SCOPE"; exit 2 ;;
esac

echo "" | tee -a "$LOG"
echo "=== RESUMO ($LABEL) ===" | tee -a "$LOG"
grep -E '^(EXIT\[|Tests:|Test Suites:)' "$LOG" | tee -a "$LOG"
echo "FALHAS=$fails" | tee -a "$LOG"
echo "log: $LOG"
exit "$fails"
