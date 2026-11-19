#!/usr/bin/env bash
# smoke-llm.sh — mostra o `llm.status` de uma busca nova (não de permalink).
#
# `disabled` = LLM_ENABLED=false (o cliente nem tenta o provedor).
# `unavailable` = tentou e falhou (chave/URL/modelo/gateway).
# `ok`/`cached`/`repaired` = funcionou.
#
# A busca é feita pelo nginx (8081), que é o caminho do navegador.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WEB_PORT=8081
[ -f "$ROOT/.env" ] && . "$ROOT/.env"

corpo="$(curl -sS -m 40 -X POST "http://127.0.0.1:${WEB_PORT}/api/v1/search" \
  -H 'content-type: application/json' \
  -d '{"query":"review python code for security issues","limit":3}' 2>/dev/null || echo '')"

if [ -z "$corpo" ]; then
  echo "  sem resposta (a API subiu? veja 'make port')"
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$corpo" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  resposta nao e JSON:", sys.stdin.read()[:200]); raise SystemExit(1)
llm = d.get("llm") or {}
data = d.get("data") or {}
print("  llm.status      :", llm.get("status"))
print("  llm.model       :", llm.get("model"))
print("  llm.cached      :", llm.get("cached"))
print("  explain_status  :", llm.get("explain_status"))
print("  degraded        :", data.get("degraded"), "| reason:", data.get("degraded_reason"))
print("  intent.category :", (d.get("intent") or {}).get("category"))
print("  intent.keywords :", (d.get("intent") or {}).get("keywords"))
print("  confianca       :", (d.get("intent") or {}).get("confidence"))
print("  resultados      :", len(d.get("results") or []))
print("  warnings        :", d.get("warnings"))
'
else
  printf '%s' "$corpo" | head -c 400
  echo
fi
