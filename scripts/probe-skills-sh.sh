#!/usr/bin/env bash
# =============================================================================
# probe-skills-sh.sh — descoberta da fonte de dados do skills.sh
#
# Objetivo: descobrir, de forma reproduzível, COMO os dados das skills são
# acessíveis (endpoint JSON, payload embutido no HTML, ou só HTML para scraping)
# e salvar uma amostra real como fixture de desenvolvimento.
#
# Roda no SEU terminal (precisa de internet). Não é executado pelo agente.
#
# Uso, na raiz do repositório:
#   bash scripts/probe-skills-sh.sh
#   bash scripts/probe-skills-sh.sh --slug <alguma-skill>   # inspeciona a página de detalhe
#
# Saída: docs/app/amostras/  (html, headers, sitemap, robots, resumo)
# e um resumo legível no terminal.
# =============================================================================
set -uo pipefail

BASE="${SKILLS_BASE_URL:-https://skills.sh}"
SLUG=""
OUT="docs/app/amostras"

while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "curl nao encontrado" >&2; exit 1; }
mkdir -p "$OUT"

C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
sec() { printf '\n%s=== %s ===%s\n' "$C" "$*" "$N"; }

# ---------- 1. conectividade e cabeçalhos ---------------------------------
sec "1. home + cabecalhos"
code=$(curl -sS -D "$OUT/home.headers.txt" -o "$OUT/home.html" -w '%{http_code}' \
        --max-time 25 -A 'Mozilla/5.0 (probe; projeto academico)' "$BASE/" 2>"$OUT/home.err") \
  || { echo "falhou: $(cat "$OUT/home.err")"; exit 1; }
printf 'status: %s   bytes: %s\n' "$code" "$(wc -c < "$OUT/home.html" | tr -d ' ')"
grep -iE '^(server|content-type|x-powered-by|cache-control|cf-|x-vercel)' "$OUT/home.headers.txt" | head -n 12

# ---------- 2. robots e sitemap ------------------------------------------
sec "2. robots.txt / sitemap"
for f in robots.txt sitemap.xml; do
  c=$(curl -sS -o "$OUT/$f" -w '%{http_code}' --max-time 15 "$BASE/$f" 2>/dev/null)
  printf '  %-12s %s  (%s bytes)\n' "$f" "$c" "$(wc -c < "$OUT/$f" 2>/dev/null | tr -d ' ')"
done
echo "  --- robots.txt (inicio) ---"
head -n 15 "$OUT/robots.txt" 2>/dev/null | sed 's/^/    /'

# ---------- 3. sondagem de endpoints --------------------------------------
sec "3. sondagem de endpoints (procura JSON)"
CANDIDATOS=(
  "/api/skills" "/api/skills?limit=1" "/api/skills/search?q=test"
  "/api/search?q=test" "/api/v1/skills" "/api/v1/search?q=test"
  "/api/categories" "/api/stats" "/api/health"
  "/openapi.json" "/api/openapi.json" "/.well-known/openapi.json"
  "/skills.json" "/index.json"
)
: > "$OUT/endpoints.txt"
for p in "${CANDIDATOS[@]}"; do
  resp=$(curl -sS -o /tmp/probe.body -w '%{http_code} %{content_type}' \
           --max-time 12 "$BASE$p" 2>/dev/null || true)
  c="${resp%% *}"
  ct="${resp#* }"
  [ "$ct" = "$resp" ] && ct="-"
  size=$(wc -c < /tmp/probe.body 2>/dev/null | tr -d ' ')
  printf '  %-32s %-4s %-28s %s bytes\n' "$p" "${c:--}" "${ct:0:28}" "${size:-0}" | tee -a "$OUT/endpoints.txt"
done
rm -f /tmp/probe.body

# ---------- 4. pistas dentro do HTML --------------------------------------
sec "4. pistas no HTML da home"
echo "  -- frameworks/estrutura --"
for pat in '__NEXT_DATA__' '__next_f' '_next/static' 'nuxt' 'astro' 'svelte' 'window.__'; do
  n=$(grep -c -- "$pat" "$OUT/home.html" 2>/dev/null || true)
  [ "${n:-0}" -gt 0 ] && printf '    %-18s %s ocorrencia(s)\n' "$pat" "$n"
done
echo "  -- campos de interesse citados no HTML --"
for pat in stars installs installations vulnerabilities security severity summary category categories github; do
  n=$(grep -oi -- "$pat" "$OUT/home.html" 2>/dev/null | wc -l | tr -d ' ')
  [ "${n:-0}" -gt 0 ] && printf '    %-16s %s\n' "$pat" "$n"
done
echo "  -- links internos (amostra) --"
grep -oE 'href="[^"]+"' "$OUT/home.html" 2>/dev/null | sed 's/href="//;s/"$//' \
  | grep -E '^/(skills|s|skill|c)' | sort -u | head -n 12 | sed 's/^/    /'

# ---------- 5. página de detalhe (opcional) ------------------------------
if [ -n "$SLUG" ]; then
  sec "5. pagina de detalhe: $SLUG"
  curl -sS -o "$OUT/detalhe.html" -D "$OUT/detalhe.headers.txt" --max-time 25 \
    -A 'Mozilla/5.0 (probe; projeto academico)' "$BASE/skills/$SLUG" 2>/dev/null
  printf '  bytes: %s\n' "$(wc -c < "$OUT/detalhe.html" | tr -d ' ')"
  echo "  -- procura SKILL.md / github / metricas --"
  for pat in 'SKILL.md' 'github.com' 'stars' 'installs' 'vulnerab' 'severity'; do
    n=$(grep -oi -- "$pat" "$OUT/detalhe.html" | wc -l | tr -d ' ')
    [ "${n:-0}" -gt 0 ] && printf '    %-14s %s\n' "$pat" "$n"
  done
  grep -oE 'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' "$OUT/detalhe.html" \
    | sort -u | head -n 5 | sed 's/^/    repo: /'
fi

# ---------- 6. veredito ---------------------------------------------------
sec "veredito"
if [ -s "$OUT/endpoints.txt" ] && grep -qE ' 200 ' "$OUT/endpoints.txt"; then
  printf '%sJSON disponivel em algum endpoint (ver docs/app/amostras/endpoints.txt)%s\n' "$G" "$N"
elif grep -qi '__NEXT_DATA__\|__next_f' "$OUT/home.html" 2>/dev/null; then
  printf '%spayload embutido no HTML (Next.js) — JSON existe dentro da pagina%s\n' "$Y" "$N"
else
  printf '%ssem JSON obvio — provavel scraping de HTML%s\n' "$Y" "$N"
fi
echo
echo "Artefatos salvos em $OUT/ — anexe ao relatorio e commite (sem dados sensiveis)."
echo "Proximo passo: com a amostra em maos, decidir o adaptador (JSON vs scraping)."
