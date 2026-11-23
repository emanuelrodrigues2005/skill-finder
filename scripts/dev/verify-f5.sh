#!/usr/bin/env bash
# verify-f5.sh — prova o que a milestone F5 entrega, pela borda publica.
#
# Roda as assercoes do job `smoke` mais as duas que a #62 acrescentou (Grafana na
# borda e /metrics fechado). Reprova com exit 1 em qualquer falha — mesmo criterio
# do pipeline.
set -uo pipefail
IP="${1:?informe o IP publico}"
BASE="http://${IP}"
FALHAS=0

passou() { printf '  OK    %s\n' "$1"; }
falhou() { printf '  FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }
codigo() { curl -s -m 10 -o /dev/null -w '%{http_code}' "$@"; }

echo "== borda: ${BASE} =="

# 1-3: o §3.3 que o smoke ja cobre
[ "$(codigo "${BASE}/healthz")" = "200" ] && passou "/healthz 200" || falhou "/healthz nao respondeu 200"
tipo="$(curl -sS -m 10 -o /dev/null -w '%{content_type}' "${BASE}/healthz" 2>/dev/null)"
case "$tipo" in application/json*) passou "/healthz JSON" ;; *) falhou "/healthz ${tipo}" ;; esac
[ "$(codigo "${BASE}/readyz")" = "200" ] && passou "/readyz 200" || falhou "/readyz nao respondeu 200"
tipo="$(curl -sS -m 10 -o /dev/null -w '%{content_type}' "${BASE}/" 2>/dev/null)"
case "$tipo" in text/html*) passou "/ HTML (SPA)" ;; *) falhou "/ ${tipo}" ;; esac
[ "$(codigo -X POST "${BASE}/api/v1/admin/ingest")" = "401" ] && passou "admin sem token 401" || falhou "admin sem token nao deu 401"

# 4-5: o que a #62 acrescentou
g="$(codigo -L "${BASE}/grafana/")"
case "$g" in 200|302) passou "/grafana/ -> ${g} (painel alcancavel)" ;; *) falhou "/grafana/ -> ${g} (esperado 200 ou 302)" ;; esac
[ "$(codigo "${BASE}/metrics")" = "404" ] && passou "/metrics 404 (fechado na borda)" || falhou "/metrics nao devolveu 404"

echo
if [ "$FALHAS" -gt 0 ]; then
  echo "FALHAS=${FALHAS}"
  exit 1
fi
echo "FALHAS=0 — F5 demonstravel pela borda publica"
