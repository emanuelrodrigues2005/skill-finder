#!/usr/bin/env bash
# diag-catalog.sh — quantas skills existem no catalogo e quais sao.
#
# Fase 2 do /diagnosing-bugs (minimizar): separar "a busca nao acha" de "o catalogo
# nao tem". Se o catalogo tem 2 itens, nenhum ajuste de ranking produzira
# `frontend-design` — o defeito esta na ingestao, nao na busca.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ -z "${BASE:-}" ]; then
  source ~/.local/bin/academy-env >/dev/null 2>&1
  ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
  BASE="http://${ALB}"
fi
XFF="X-Forwarded-For: 203.0.113.250"

echo "== catalogo: quantas skills =="
curl -sS -m 30 "${BASE}/api/v1/skills?limit=100" -H "$XFF" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
itens = d.get("data") or d.get("results") or d.get("items") or []
print(f"  total devolvido: {len(itens)}")
print(f"  meta: {json.dumps(d.get(\"meta\") or {}, ensure_ascii=False)}")
for x in itens[:20]:
    print(f"  - {x.get(\"skill_id\")}  {x.get(\"name\")}  cat={x.get(\"category\")}  stars={x.get(\"stars\")}")
' 2>&1

echo
echo "== categorias =="
curl -sS -m 30 "${BASE}/api/v1/categories" -H "$XFF" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("  " + json.dumps(d, ensure_ascii=False)[:400])
' 2>&1

echo
echo "== /readyz (frescor do snapshot) =="
curl -sS -m 20 "${BASE}/readyz" -H "$XFF" | python3 -m json.tool 2>&1 | head -20
