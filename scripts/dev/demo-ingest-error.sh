#!/usr/bin/env bash
# demo-ingest-error.sh — tenta gerar `level="error"` sem mexer na infraestrutura.
#
# Por que existe: o painel "Logs de erro da API" filtra `level="error"`, e o
# logger so marca `error` em 5xx ou quando uma excecao e registrada. Uma ingestao
# com chave que nao existe na fonte deveria falhar no fetch e produzir essa linha
# — sem derrubar banco, sem mudar catalogo (a chave e descartada).
#
# O token vem do cofre e nunca e impresso.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
BASE="http://${ALB}"

echo "== ingestao com chave inexistente =="
codigo="$(curl -sS -o /tmp/ing.json -w '%{http_code}' -m 90 -X POST "${BASE}/api/v1/admin/ingest" \
  -H "content-type: application/json" \
  -H "X-Admin-Token: ${ADMIN_TOKEN:-}" \
  -d '{"source_keys":["nao-existe-owner/nao-existe-repo/skill"]}' 2>/dev/null)"
echo "  status: ${codigo}"
head -c 300 /tmp/ing.json 2>/dev/null; echo

echo
echo "== aguardando o Promtail (5 s) =="
sleep 5
python3 scripts/dev/loki.py 2>&1 | head -6
