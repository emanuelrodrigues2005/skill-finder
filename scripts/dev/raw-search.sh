#!/usr/bin/env bash
# raw-search.sh — despeja UMA resposta crua do /search para inspecionar o contrato.
#
# Existe porque o loop de diagnostico estava afirmando "ordem vazia" por erro de
# parser, nao por ausencia de resultado: sem ver o JSON real, o loop mentiria.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ -z "${BASE:-}" ]; then
  source ~/.local/bin/academy-env >/dev/null 2>&1
  ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
  BASE="http://${ALB}"
fi
Q="${1:-quero uma skill para design frontend}"

curl -sS -m 40 -X POST "${BASE}/api/v1/search" \
  -H 'content-type: application/json' \
  -H "X-Forwarded-For: 198.51.100.$((RANDOM % 200 + 1))" \
  -d "{\"query\":\"${Q}\",\"limit\":5}" \
  | python3 -m json.tool 2>&1 | head -80
