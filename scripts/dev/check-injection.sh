#!/usr/bin/env bash
# check-injection.sh — quais segredos o `secrets-manager run` realmente injeta.
#
# Imprime NOME=presente/VAZIO, nunca o valor. Existe porque a CLI lista todos os
# segredos com `secrets get` mas o `run` pode injetar so o caminho raiz — e a
# diferenca entre "esta no cofre" e "chega ao processo" foi o que derrubou o
# deploy da observabilidade com "GRAFANA_PASSWORD ausente".
set -uo pipefail
PROJ="${1:-2af53052-6e7a-4e59-a321-4525fa7fadae}"
ENV="${2:-prod}"

cat > /tmp/probe-env.sh <<'PROBE'
for v in ADMIN_TOKEN DATABASE_URL GRAFANA_PASSWORD IP_HASH_SALT LLM_API_KEY POSTGRES_PASSWORD; do
  if [ -n "${!v:-}" ]; then
    printf '  %-20s presente (%s chars)\n' "$v" "${#v}"
  else
    printf '  %-20s VAZIO\n' "$v"
  fi
done
PROBE

infisical secrets-manager run --projectId "$PROJ" --env "$ENV" -- bash /tmp/probe-env.sh 2>&1 \
  | grep -vE 'new release|To update|INF ' || true
rm -f /tmp/probe-env.sh
