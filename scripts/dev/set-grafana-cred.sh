#!/usr/bin/env bash
# set-grafana-cred.sh — gera senha forte e grava no cofre como GRAFANA_PASSWORD.
#
# Alfabeto sem `@ : / ? #` de proposito: a senha vai ser digitada a mao no login e
# esses caracteres quebram URL, copiar/colar de terminal e a interpolacao do
# compose. 20 caracteres de [A-Za-z0-9] dao ~119 bits, folgado para um painel de
# demonstracao.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
PROJ="2af53052-6e7a-4e59-a321-4525fa7fadae"
ENV="prod"

if [ "${1:-}" = "--reuse" ]; then
  echo "modo --reuse: nao gera, so confirma que existe"
  bash scripts/dev/secrets-names.sh "$PROJ" "$ENV" | grep -qx GRAFANA_PASSWORD \
    && echo "GRAFANA_PASSWORD presente" || { echo "AUSENTE"; exit 1; }
  exit 0
fi

PW="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 20)"
[ "${#PW}" -eq 20 ] || { echo "FALHA ao gerar senha com 20 chars" >&2; exit 1; }

infisical secrets-manager secrets update "GRAFANA_PASSWORD=${PW}" \
  --projectId "$PROJ" --env "$ENV" >/dev/null 2>&1 \
  || infisical secrets-manager secrets create "GRAFANA_PASSWORD=${PW}" \
       --projectId "$PROJ" --env "$ENV" >/dev/null 2>&1 \
  || { echo "FALHA ao gravar no cofre" >&2; exit 1; }

# Unica linha que imprime o valor, porque o dono pediu para saber a senha.
echo "GRAFANA_PASSWORD=${PW}"
