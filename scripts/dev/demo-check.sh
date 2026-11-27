#!/usr/bin/env bash
# demo-check.sh — verificacao final antes de gravar o video.
#
# Confere o que o video vai mostrar: a busca devolvendo a skill certa em 1o, a
# pergunta ecoada (primeiro turno da transcricao), o Grafana no ar e o catalogo
# com o tamanho esperado.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
BASE="http://${ALB}"
echo "URL: ${BASE}"
echo "Grafana: ${BASE}/grafana/   (ejtr2005)"
echo

echo "== consultas do roteiro =="
python3 scripts/dev/verify-query-echo.py "$BASE" "quero uma skill para design frontend" 2>&1 | sed 's/^/  /'
echo
python3 scripts/dev/verify-query-echo.py "$BASE" "quero uma skill que ajude a escrever testes antes do codigo" 2>&1 | sed 's/^/  /'
