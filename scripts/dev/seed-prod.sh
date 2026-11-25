#!/usr/bin/env bash
# seed-prod.sh — semeia o catalogo em PRODUCAO usando o token do cofre.
#
# O token nunca aparece: chega por `secrets-manager run` e o seed so o usa no
# header. O alvo e o proprio ALB, entao nao depende de redeploy — o catalogo
# cresce na hora, que e o que o dono precisa para testar.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
if [ -z "${ALB:-}" ]; then
  echo "FALHA: sem alb_dns_name no state; a infra esta de pe?" >&2
  exit 1
fi
BASE="http://${ALB}"
echo "alvo: ${BASE}"
echo "limite: ${1:-120}"
echo

infisical secrets-manager run \
  --projectId 2af53052-6e7a-4e59-a321-4525fa7fadae --env prod \
  -- bash scripts/dev/seed-catalog.sh --base "$BASE" --limit "${1:-120}" 2>&1 \
  | grep -vE 'new release|To update|INF Injecting'
