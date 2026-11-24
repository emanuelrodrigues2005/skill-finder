#!/usr/bin/env bash
# check-bind.sh — confere os binds do compose e se o deploy os abre.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1

echo "== perfis =="
for p in web api db obs dev; do
  if docker compose --profile "$p" config -q >/dev/null 2>&1; then
    printf '  OK    %s\n' "$p"
  else
    printf '  FALHA %s\n' "$p"
  fi
done

echo "== binds renderizados (sem API_BIND no ambiente) =="
docker compose --profile api config 2>/dev/null | grep -A2 'host_ip' | head -6
docker compose --profile obs config 2>/dev/null | grep -c '127.0.0.1' | sed 's/^/  ocorrencias de 127.0.0.1 em obs: /'

echo "== o deploy exporta os binds? =="
if grep -qn 'API_BIND' .github/workflows/deploy.yml; then
  grep -n 'API_BIND\|GRAFANA_BIND' .github/workflows/deploy.yml | head -4
else
  echo "  AUSENTE: deploy.yml nao exporta API_BIND (a api ficaria em loopback na VM)"
fi

echo "== perfis de servico =="
printf '  api  : %s\n' "$(docker compose --profile api config --services 2>/dev/null | tr '\n' ' ')"
printf '  db   : %s\n' "$(docker compose --profile db config --services 2>/dev/null | tr '\n' ' ')"
printf '  web  : %s\n' "$(docker compose --profile web config --services 2>/dev/null | tr '\n' ' ')"
printf '  dev  : %s\n' "$(docker compose --profile dev config --services 2>/dev/null | tr '\n' ' ')"
