#!/usr/bin/env bash
# smoke-edge.sh — as quatro asserções do job `smoke`, executadas contra a borda.
#
# Existe para provar a aplicacao pela borda publica SEM depender do job do workflow
# (que segue com o defeito do `outputs`). Cada assercao reprova com `exit 1` — mesmo
# criterio do job: nada de "imprimiu e seguiu".
#
# Uso: bash scripts/dev/smoke-edge.sh <ip>
set -uo pipefail
IP="${1:?informe o IP publico}"
BASE="http://${IP}"
FALHAS=0

passou() { printf '  OK   %s\n' "$1"; }
falhou() { printf '  FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }

echo "== borda: ${BASE} =="

# 1. /healthz responde JSON com status ok
if corpo="$(curl -fsS -m 10 "${BASE}/healthz" 2>/dev/null)"; then
  if printf '%s' "$corpo" | grep -q '"status":"ok"'; then
    passou "/healthz -> {\"status\":\"ok\"}"
  else
    falhou "/healthz respondeu sem status ok: $(printf '%s' "$corpo" | head -c 80)"
  fi
else
  falhou "/healthz nao respondeu"
fi

# 2. /healthz e JSON, nao o index.html da SPA
tipo="$(curl -sS -m 10 -o /dev/null -w '%{content_type}' "${BASE}/healthz" 2>/dev/null)"
case "$tipo" in
  application/json*) passou "/healthz content-type: ${tipo}" ;;
  *)                 falhou "/healthz content-type: ${tipo} (esperado application/json)" ;;
esac

# 3. /readyz com o Postgres up
if corpo="$(curl -fsS -m 10 "${BASE}/readyz" 2>/dev/null)"; then
  if printf '%s' "$corpo" | grep -q '"status":"ok"'; then
    passou "/readyz -> {\"status\":\"ok\"}"
  else
    falhou "/readyz sem status ok: $(printf '%s' "$corpo" | head -c 80)"
  fi
else
  falhou "/readyz nao respondeu"
fi

# 4. a SPA e servida na raiz
tipo="$(curl -sS -m 10 -o /dev/null -w '%{content_type}' "${BASE}/" 2>/dev/null)"
case "$tipo" in
  text/html*) passou "/ content-type: ${tipo}" ;;
  *)          falhou "/ content-type: ${tipo} (esperado text/html)" ;;
esac

# 5. o endpoint admin recusa sem token
codigo="$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/v1/admin/ingest" 2>/dev/null)"
if [ "$codigo" = "401" ]; then
  passou "POST /admin/ingest sem token -> 401"
else
  falhou "POST /admin/ingest sem token -> ${codigo} (esperado 401)"
fi

echo
if [ "$FALHAS" -gt 0 ]; then
  echo "FALHAS=${FALHAS}"
  exit 1
fi
echo "FALHAS=0 — a aplicacao responde corretamente pela borda publica"
