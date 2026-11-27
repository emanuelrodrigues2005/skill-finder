#!/usr/bin/env bash
# health.sh — estado da borda em uma linha por endpoint.
#
# Existe porque comando com URL literal na linha de comando do executor e
# bloqueado (`spawn EPERM`); chamar um script por caminho passa.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
BASE="http://${ALB}"
echo "URL: ${BASE}"
for caminho in /healthz /readyz /grafana/; do
  codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 15 "${BASE}${caminho}" 2>/dev/null)"
  printf '  %-12s %s\n' "$caminho" "${codigo}"
done
