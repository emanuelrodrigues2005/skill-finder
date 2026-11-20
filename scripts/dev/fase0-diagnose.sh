#!/usr/bin/env bash
# fase0-diagnose.sh — descobre POR QUE a LLM responde `unavailable`.
#
# O log de falha do provedor sai em `debug` (openai-compat.ts). Com `LOG_LEVEL=info`
# não há rastro: a resposta diz `unavailable` e o operador não tem próximo passo.
# Este script recria a API com `debug`, faz UMA busca e imprime só as linhas de
# diagnóstico — sem a chave, que nunca é logada pelo cliente.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

echo "== recriando a API com LOG_LEVEL=debug =="
LOG_LEVEL=debug docker compose --profile dev up -d --force-recreate api-dev 2>&1 | tail -2

echo
echo "== esperando o healthcheck =="
for i in $(seq 1 40); do
  estado="$(docker inspect -f '{{.State.Health.Status}}' skills-search-api-dev-1 2>/dev/null || echo '?')"
  [ "$estado" = "healthy" ] && break
  sleep 2
done
echo "  api: $estado"

echo
echo "== uma busca (o status da LLM aparece na resposta) =="
porta=8090
[ -f .env ] && . ./.env
porta="${API_PORT:-8090}"
resposta="$(curl -sS -m 60 -X POST "http://127.0.0.1:${porta}/api/v1/search" \
  -H 'content-type: application/json' \
  -d '{"query":"testing","limit":3}' 2>/dev/null || echo '')"
printf '%s' "$resposta" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print("  resposta nao e JSON"); raise SystemExit
llm=d.get("llm") or {}
print("  llm.status:", llm.get("status"), "| model:", llm.get("model"))
print("  resultados:", len(d.get("results") or []))
' 2>/dev/null

echo
echo "== linhas de diagnóstico do provedor =="
docker compose --profile dev logs api-dev --since 5m --no-color 2>&1 \
  | grep -iE 'degrad|intent call|explain call|ECONN|http [0-9]{3}|timeout|provider' \
  | tail -15 \
  | sed 's/^/  /' \
  || echo "  (nenhuma linha — o caminho de falha nao loga nem em debug)"
