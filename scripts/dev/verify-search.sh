#!/usr/bin/env bash
# verify-search.sh — verifica a busca em producao com o contrato real.
#
# Encapsula a URL do ALB para nao depender de ordem de argumento, e checa a
# asserção que o dono fez: consulta -> skill esperada no topo.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
if [ -z "${ALB:-}" ]; then
  echo "FALHA: sem alb_dns_name no state" >&2
  exit 1
fi
BASE="http://${ALB}"
echo "API: ${BASE}"
echo

python3 scripts/dev/check-intent.py "$BASE" \
  "quero uma skill para design frontend" \
  "quero uma skill que ajude a escrever testes antes do codigo" \
  "preciso revisar seguranca de uma pull request"
