#!/usr/bin/env bash
# smoke-live.sh — testa o enriquecimento ao vivo de ponta a ponta.
#
# Faz uma busca que o catálogo local (25 fixtures) não cobre e mostra: o status da
# LLM, as palavras-chave em inglês usadas no FTS, quantos resultados vieram e, se
# veio vazio, quanto tempo o enriquecimento levou.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB=8081
[ -f "$ROOT/.env" ] && . "$ROOT/.env"
WEB="${WEB_PORT:-8081}"
CONSULTA="${1:-quero uma skill para desenvolvimento com testes}"

inicio=$(date +%s)
corpo="$(curl -sS -m 180 -X POST "http://127.0.0.1:${WEB}/api/v1/search" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"${CONSULTA}\",\"limit\":5}" 2>/dev/null || echo '')"
fim=$(date +%s)

if [ -z "$corpo" ]; then
  echo "  sem resposta (o request pode ter estourado o timeout de 180 s)"
  exit 1
fi

printf '%s' "$corpo" | python3 -c '
import json, sys
d = json.load(sys.stdin)
llm = d.get("llm") or {}
intent = d.get("intent") or {}
results = d.get("results") or []
print("  llm.status    :", llm.get("status"))
print("  keywords      :", intent.get("keywords"))
print("  confianca     :", intent.get("confidence"))
print("  resultados    :", len(results))
for item in results:
    print("    #%s %-28s score=%s" % (item.get("rank"), (item.get("skill") or {}).get("name"), item.get("score")))
print("  warnings      :", d.get("warnings"))
' 2>/dev/null || printf '%s' "$corpo" | head -c 300

echo "  tempo total   : $((fim - inicio)) s"
