#!/usr/bin/env bash
# probe-skills-sitemap.sh — confirma o formato das chaves do sitemap do skills.sh.
#
# O fallback ao vivo filtra as chaves pelo slug da URL antes de buscar detalhe. Se o
# sitemap nao for o que a coleta registrou, o filtro nao casa nada — melhor descobrir
# antes de escrever codigo.
set -uo pipefail
BASE="https://www.skills.sh"

echo "== robots.txt (politica vigente) =="
curl -sS -m 20 "$BASE/robots.txt" | head -20 | sed 's/^/  /'

echo
echo "== sitemap index =="
curl -sS -m 20 "$BASE/sitemap.xml" | head -c 700
echo

echo
echo "== primeiro shard: 3 <loc> =="
shard=$(curl -sS -m 20 "$BASE/sitemap.xml" | grep -o '<loc>[^<]*</loc>' | head -1 | sed 's|</\?loc>||g')
echo "  shard: $shard"
curl -sS -m 25 "$shard" | grep -o '<loc>[^<]*</loc>' | head -3 | sed 's/^/  /'

echo
echo "== quantos <loc> no total (amostra do primeiro shard) =="
curl -sS -m 25 "$shard" | grep -c '<loc>'

echo
echo "== a chave derivada e 'owner/repo/slug'? =="
curl -sS -m 25 "$shard" | grep -o '<loc>[^<]*</loc>' | head -1 | sed 's|</\?loc>||g' | sed 's|^https://www.skills.sh/||' | sed 's/^/  chave: /'
