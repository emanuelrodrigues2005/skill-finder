#!/usr/bin/env bash
# probe-sitemap.sh — descobre quais skills reais existem no skills.sh.
#
# Por que existe: o deploy semeia duas source_keys escritas a mao. Antes de
# planejar a correcao, preciso saber se as skills que o dono espera
# (`frontend-design`, `tdd`) existem no catalogo da fonte — e quantas ha no total.
#
# Le o sitemap (o caminho que o projeto ja usa e que o robots.txt permite), nao a
# API: a API exige token OIDC da Vercel e o robots proibe `/api/`.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
UA="skill-finder-catalog/0.1 (+https://github.com/emanuelrodrigues2005/skill-finder)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== sitemap index =="
curl -sS -m 60 -A "$UA" https://www.skills.sh/sitemap.xml -o "$TMP/idx.xml" && \
  grep -oE '<loc>[^<]+</loc>' "$TMP/idx.xml" | sed 's/<[^>]*>//g' | sed 's/^/  /'

TOTAL=0
for n in 1 2; do
  url="https://www.skills.sh/sitemap-skills-$n.xml"
  echo
  echo "== $url =="
  if ! curl -sS -m 180 -A "$UA" "$url" -o "$TMP/s$n.xml"; then
    echo "  FALHOU (rede ou bloqueio)"; continue
  fi
  qtd="$(grep -c '<loc>' "$TMP/s$n.xml" 2>/dev/null || echo 0)"
  echo "  urls: ${qtd}"
  TOTAL=$((TOTAL + qtd))

  for alvo in frontend-design tdd; do
    achado="$(grep -oE "<loc>[^<]*/${alvo}</loc>" "$TMP/s$n.xml" | head -3 | sed 's/<[^>]*>//g')"
    if [ -n "$achado" ]; then
      printf '  %-18s %s\n' "$alvo" "$(echo "$achado" | tr '\n' ' ')"
    fi
  done
done

echo
echo "== total de URLs nos dois shards: ${TOTAL} =="
