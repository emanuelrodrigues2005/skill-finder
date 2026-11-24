#!/usr/bin/env bash
# nginx-check.sh — valida a sintaxe do nginx com o arquivo do repositorio.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "== montagens do container web =="
docker inspect skills-search-web-1 --format '{{range .Mounts}}{{.Source}} => {{.Destination}}{{"\n"}}{{end}}' 2>&1 | sed 's/^/  /'

echo
echo "== a config do container ve a mudanca do repositorio? =="
# A sonda usa `location = /metrics`, que e a ultima coisa que a borda ainda faz
# (ADR-014). Ela procurava `api/v1/admin` ate a F7.7 — o bloco saiu do arquivo de
# proposito, e a sonda passou a responder "nao" mesmo com o bind mount novo.
if docker exec skills-search-web-1 grep -q 'location = /metrics' /etc/nginx/nginx.conf 2>/dev/null; then
  echo "  sim: o bind mount ja reflete o arquivo novo"
else
  echo "  nao: o container tem a versao antiga (imagem construida antes)"
fi

echo
echo "== nginx -t no container =="
docker exec skills-search-web-1 nginx -t 2>&1 | sed 's/^/  /'

echo
echo "== validacao independente: monta o arquivo num nginx limpo =="
docker run --rm \
  -v "$ROOT/frontend/nginx.conf:/etc/nginx/nginx.conf:ro" \
  --add-host api:127.0.0.1 \
  nginx:alpine nginx -t 2>&1 | sed 's/^/  /'
