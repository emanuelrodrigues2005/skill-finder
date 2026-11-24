#!/usr/bin/env bash
# check-nginx-static.sh — a borda do front é só estática depois da ADR-014.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
CONF="frontend/nginx.conf"
falhas=0

conta() { grep -c "$1" "$CONF" 2>/dev/null || echo 0; }

# A checagem ignora linhas de comentario: o arquivo explica em prosa o que deixou
# de existir (ADR-014), e um `grep` cru acharia a explicacao em vez da diretiva.
# Ja aconteceu duas vezes nesta milestone — o criterio medindo a descricao do
# criterio.
diretivas() { grep -v '^[[:space:]]*#' "$CONF"; }

echo "== o que a borda ainda faz =="
printf '  add_header ......... %s (3 = os de seguranca)\n' "$(conta 'add_header')"
printf '  location /metrics .. %s\n' "$(conta 'location = /metrics')"
printf '  return 404 ......... %s\n' "$(conta 'return 404')"

echo "== o que ela nao faz mais (ADR-014) =="
# `proxy_temp_path` fica de fora da lista: o modulo proxy cria esse diretorio no
# boot mesmo sem `proxy_pass`, e aponta-lo para /tmp e o que dispensa escrever em
# /var/cache/nginx. Nao e proxy: e o temporario dele.
for padrao in 'proxy_pass' 'upstream ' 'X-Real-IP' 'X-Forwarded-For' 'grafana:3000'; do
  n="$(diretivas | grep -c "$padrao" 2>/dev/null || true)"
  n="${n:-0}"
  if [ "$n" -eq 0 ]; then
    printf '  OK    %s ausente\n' "$padrao"
  else
    printf '  FALHA %s ainda presente (%s)\n' "$padrao" "$n"
    falhas=$((falhas + 1))
  fi
done

echo "== sintaxe =="
if docker run --rm -v "$PWD/$CONF:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
  echo "  OK    nginx -t limpo (montado em /etc/nginx/nginx.conf, como o Dockerfile faz)"
else
  echo "  FALHA nginx -t reprovou"
  falhas=$((falhas + 1))
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "VEREDITO: borda estatica, sem proxy"
else
  echo "FALHAS=${falhas}"
  exit 1
fi
