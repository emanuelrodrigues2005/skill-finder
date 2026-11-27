#!/usr/bin/env bash
# status-demo.sh — o estado da stack em um comando, antes de gravar.
#
# Mostra: saude da borda, o topo de uma busca real e as ultimas linhas de erro no
# Loki (o que o painel 4 do dashboard mostra). Sem argumento com URL na linha de
# comando, porque o executor bloqueia comando com URL literal.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
BASE="http://${ALB}"

echo "URL .....: ${BASE}"
echo "Grafana .: ${BASE}/grafana/   (ejtr2005)"
echo

echo "== borda =="
for caminho in /healthz /readyz /grafana/; do
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "${BASE}${caminho}" 2>/dev/null)"
  printf '  %-11s %s\n' "$caminho" "$codigo"
done

echo
echo "== busca real (top 3) =="
SF_BASE="$BASE" python3 - <<'PY'
import json, os, random, urllib.request
base = os.environ["SF_BASE"]
corpo = json.dumps({"query": "quero uma skill para design frontend", "limit": 3}).encode()
req = urllib.request.Request(
    f"{base}/api/v1/search",
    data=corpo,
    headers={"content-type": "application/json",
             "X-Forwarded-For": f"198.50.{random.randint(1,250)}.{random.randint(1,250)}"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=60) as r:
    d = json.loads(r.read().decode())
print(f"  query ecoada: {d.get('query')!r}")
print(f"  llm: {d.get('llm', {}).get('status')}  modelo={d.get('llm', {}).get('model')}")
for item in d.get("results") or []:
    print(f"  {item.get('rank')}. {item.get('skill', {}).get('name')}")
PY

echo
echo "== Loki: linhas level=error (painel 4) =="
SF_BASE="$BASE" python3 scripts/dev/loki.py 2>&1 | sed 's/^/  /'
