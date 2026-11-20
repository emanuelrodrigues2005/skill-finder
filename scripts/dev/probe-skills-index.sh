#!/usr/bin/env bash
# probe-skills-index.sh — uma requisicao que decide se existe atalho oficial JSON.
#
# Contexto: `robots.txt` do skills.sh proibe /api/ e /search; so `/` e permitido.
# O padrao emergente `/.well-known/agent-skills/index.json` seria o unico caminho
# "JSON + oficial + permitido". Este script responde com 1 GET.
set -uo pipefail

echo "== /.well-known/agent-skills/index.json =="
code="$(curl -sS -o /tmp/well-known.json -w '%{http_code}' --max-time 20 \
  https://www.skills.sh/.well-known/agent-skills/index.json 2>/dev/null || echo 000)"
echo "  HTTP $code"
if [ "$code" = "200" ]; then
  echo "  primeiros 300 bytes:"
  head -c 300 /tmp/well-known.json | sed 's/^/    /'
fi

echo
echo "== robots.txt (politica publicada) =="
curl -sS --max-time 20 https://www.skills.sh/robots.txt 2>/dev/null | grep -E 'User-Agent|Allow|Disallow|Sitemap' | sed 's/^/  /'

echo
echo "== volume real: shard 2 do sitemap =="
n2="$(curl -sS --max-time 25 https://www.skills.sh/sitemap-skills-2.xml 2>/dev/null | grep -c '<loc>' || echo 0)"
echo "  sitemap-skills-2.xml: $n2 <loc>"
echo "  (shard 1 congelado em docs/app/amostras tem 10000)"
