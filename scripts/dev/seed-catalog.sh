#!/usr/bin/env bash
# seed-catalog.sh — semeia o catálogo: as curadas de `seed-skills.txt` e depois N
# chaves do sitemap do skills.sh.
#
# Por que existe: a rota `POST /api/v1/admin/ingest` exige `source_keys`, e com
# chaves explícitas o `ingest` não roda `selectCycleKeys` — ou seja, o rodízio
# nunca é montado por um caminho de produção. O seed explícito é hoje a única
# forma de o catálogo crescer, e ele deixou de ser duas chaves fixas.
#
#   bash scripts/dev/seed-catalog.sh --limit 120 --dry-run   # só lista as chaves
#   ADMIN_TOKEN=... bash scripts/dev/seed-catalog.sh --limit 20
#   ADMIN_TOKEN=... bash scripts/dev/seed-catalog.sh --base http://127.0.0.1:8000 --cycle
#
# O token nunca é impresso: ele só existe no `-H` do curl.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CURADAS="$ROOT/scripts/dev/seed-skills.txt"
CACHE="$ROOT/docs/app/amostras"
UA="skill-finder-catalog/0.1 (+https://github.com/emanuelrodrigues2005/skill-finder)"
SOURCE_BASE="${SKILL_SOURCE_BASE:-https://www.skills.sh}"

# Teto de chaves por chamada: a rota valida `ArrayMaxSize(20)` e responde 422
# acima disso.
BATCH=20

# Teto por repositório da parte do sitemap: a ordem publicada é dominada por
# poucos repos que publicaram em massa (sem o teto, 90 chaves saem de 17 repos,
# 19 delas `microsoft/azure-skills`) e o catálogo não demonstra nada.
MAX_POR_REPO=3

LIMIT=120
BASE="http://127.0.0.1:8000"
DRY=0
CYCLE=0

uso() {
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --limit)
      LIMIT="${2:-}"
      shift 2 || { echo "falta o valor de --limit" >&2; exit 2; }
      ;;
    --base)
      BASE="${2:-}"
      shift 2 || { echo "falta o valor de --base" >&2; exit 2; }
      ;;
    --dry-run)
      DRY=1
      shift
      ;;
    --cycle)
      CYCLE=1
      shift
      ;;
    -h | --help)
      uso
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $1 (use --help)" >&2
      exit 2
      ;;
  esac
done

case "$LIMIT" in
  '' | *[!0-9]*) echo "--limit precisa ser inteiro (recebido '${LIMIT}')" >&2; exit 2 ;;
esac
LIMIT=$((10#$LIMIT))
if [ "$LIMIT" -le 0 ]; then
  echo "--limit precisa ser > 0" >&2
  exit 2
fi
if [ "$DRY" -eq 0 ] && [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN ausente: exporte o token do ambiente admin" >&2
  exit 2
fi

SITEMAP_TMP="$(mktemp -d)"
VISTAS="$(mktemp)"
CORPO="$(mktemp)"
trap 'rm -rf "$SITEMAP_TMP" "$VISTAS" "$CORPO"' EXIT

# `tr -d '\r'`: o checkout vive em /mnt/c (9p) e um editor do Windows deixa CRLF;
# a chave com `\r` no fim não casa com o sitemap e vira seed perdido.
curadas=()
if [ -s "$CURADAS" ]; then
  mapfile -t curadas < <(tr -d '\r' < "$CURADAS" | sed 's/[[:space:]]*$//' | grep -vE '^[[:space:]]*(#|$)' || true)
fi
if [ "${#curadas[@]}" -eq 0 ]; then
  echo "lista curada vazia ou ausente: ${CURADAS}" >&2
  exit 1
fi

# Os dois shards do sitemap são o mesmo caminho que o adaptador `html` já usa (o
# robots.txt permite `sitemap*.xml` e proíbe `/api/`). Sem rede, cai no sitemap
# em cache do repositório: o seed segue reproduzível offline e o aviso diz que
# foi o cache.
carregar_sitemap() {
  local n url carregados=0
  for n in 1 2; do
    url="$SOURCE_BASE/sitemap-skills-${n}.xml"
    if curl -fsS -m 180 -A "$UA" "$url" -o "$SITEMAP_TMP/s$n.xml" 2> /dev/null; then
      carregados=$((carregados + 1))
      continue
    fi
    if [ -s "$CACHE/sitemap-skills-$n.xml" ]; then
      cp "$CACHE/sitemap-skills-$n.xml" "$SITEMAP_TMP/s$n.xml"
      carregados=$((carregados + 1))
      echo "aviso: ${url} indisponivel; usando o sitemap em cache (docs/app/amostras/sitemap-skills-${n}.xml)" >&2
      continue
    fi
    echo "aviso: ${url} indisponivel e sem cache local; shard ${n} ignorado" >&2
  done
  if [ "$carregados" -eq 0 ]; then
    echo "ERRO: nenhum shard do sitemap foi lido; sem as chaves da fonte nao ha o que semear" >&2
    exit 1
  fi
}

# URL de detalhe -> `owner/repo/slug`. Só chave de três segmentos: `/api/...` e as
# páginas de listagem do site não são skills.
chaves_do_sitemap() {
  cat "$SITEMAP_TMP"/s?.xml \
    | grep -oE '<loc>[^<]+</loc>' \
    | sed 's|</\?loc>||g; s|^'"$SOURCE_BASE"'/||' \
    | awk -F/ 'NF == 3 && $1 != "" && $2 != "" && $3 != ""' || true
}

# Curadas primeiro: são a demonstração do dono e o que não pode cair no corte do
# `--limit`. O sitemap só completa o que faltar, sem repetir chave.
selecionadas=()
adicionar() { # 0 = entrou, 1 = já estava ou o limite cortou
  [ -n "$1" ] || return 1
  [ "${#selecionadas[@]}" -lt "$LIMIT" ] || return 1
  if grep -qxF -- "$1" "$VISTAS"; then
    return 1
  fi
  printf '%s\n' "$1" >> "$VISTAS"
  selecionadas+=("$1")
}

for key in "${curadas[@]}"; do
  adicionar "$key" || true
done
n_curadas=${#selecionadas[@]}

declare -A por_repo=()
if [ "$n_curadas" -lt "$LIMIT" ]; then
  carregar_sitemap
  while IFS= read -r key; do
    [ "${#selecionadas[@]}" -lt "$LIMIT" ] || break
    repo="${key%/*}"
    [ "${por_repo[$repo]:-0}" -lt "$MAX_POR_REPO" ] || continue
    if adicionar "$key"; then
      por_repo[$repo]=$((${por_repo[$repo]:-0} + 1))
    fi
  done < <(chaves_do_sitemap)
fi

if [ "${#selecionadas[@]}" -lt "$LIMIT" ]; then
  echo "aviso: só ${#selecionadas[@]} chaves únicas disponíveis para --limit ${LIMIT}" >&2
fi

n_sitemap=$((${#selecionadas[@]} - n_curadas))
lotes=$(((${#selecionadas[@]} + BATCH - 1) / BATCH))

if [ "$DRY" -eq 1 ]; then
  printf '%s\n' "${selecionadas[@]}"
  echo "resumo: ${#selecionadas[@]} chaves (curadas ${n_curadas}, sitemap ${n_sitemap}), ${lotes} lote(s) de ${BATCH} — dry-run, nada foi chamado" >&2
  exit 0
fi

# Sequencial de propósito: o limitador é do servidor (`SKILL_SOURCE_RPS`, 1 req/s)
# e a rota responde 409 enquanto houver run em andamento — lote em paralelo só
# queimaria tentativa.
json_das_chaves() {
  local saida="" key
  for key in "$@"; do
    saida+="\"${key}\","
  done
  printf '{"source_keys":[%s]}' "${saida%,}"
}

# Grava o corpo em `$2` e imprime o código HTTP; 409/429 ficam para quem chama.
postar() {
  curl -sS -m 300 --retry-connrefused --retry-delay 2 --retry 5 \
    -o "$2" -w '%{http_code}' \
    -X POST "${BASE}/api/v1/admin/ingest" \
    -H "X-Admin-Token: ${ADMIN_TOKEN}" -H 'Content-Type: application/json' \
    -d "$1" || true
}

campo() { # campo <arquivo> <nome> — tolera espaço depois dos dois-pontos
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p" "$1" 2> /dev/null | head -1 || true
}

status_de() { # status_de <arquivo>
  sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$1" 2> /dev/null | head -1 || true
}

inicio="$(date +%s)"

if [ "$CYCLE" -eq 1 ]; then
  # O `ingest` sabe rodar sem `keys` (é o rodízio), mas a rota exige 1–20
  # `source_keys`: sem chave ela responde 422 e o ciclo não tem caminho. Tenta e
  # registra o que a rota responder, sem forçar.
  code="$(postar '{}' "$CORPO")"
  case "$code" in
    2??) echo "ciclo: ${code} items_upserted=$(campo "$CORPO" items_upserted) status=$(status_de "$CORPO")" ;;
    409 | 429) echo "ciclo: ${code} — run concorrente em andamento, ciclo nao disparado" ;;
    *) echo "ciclo: nao exposto pela rota (${code}: $(head -c 200 "$CORPO" 2> /dev/null || true)); seguindo com o seed explicito" ;;
  esac
fi

lote=0
upsertados=0
concorrentes=0
for ((i = 0; i < ${#selecionadas[@]}; i += BATCH)); do
  lote=$((lote + 1))
  fatia=("${selecionadas[@]:i:BATCH}")
  code=""
  for tentativa in 1 2 3 4 5 6; do
    code="$(postar "$(json_das_chaves "${fatia[@]}")" "$CORPO")"
    case "$code" in
      409 | 429)
        echo "lote ${lote}/${lotes}: ${code} (tentativa ${tentativa}/6), aguardando 15s" >&2
        sleep 15
        ;;
      *) break ;;
    esac
  done

  case "$code" in
    2??)
      n="$(campo "$CORPO" items_upserted)"
      upsertados=$((upsertados + ${n:-0}))
      echo "lote ${lote}/${lotes}: ${code} items_upserted=${n:-0} vistos=$(campo "$CORPO" items_seen) status=$(status_de "$CORPO")"
      ;;
    401 | 403)
      echo "ERRO: token recusado pela API (${code}); o seed nao pode continuar" >&2
      exit 1
      ;;
    409 | 429)
      concorrentes=$((concorrentes + 1))
      echo "aviso: lote ${lote}/${lotes} ficou em ${code} apos 6 tentativas; run concorrente assume estas ${#fatia[@]} chaves" >&2
      ;;
    *)
      echo "ERRO: lote ${lote}/${lotes} respondeu '${code}' (${BASE}); corpo: $(head -c 300 "$CORPO" 2> /dev/null || true)" >&2
      exit 1
      ;;
  esac
done

decorrido=$(($(date +%s) - inicio))
curl -fsS -m 30 "${BASE}/api/v1/skills?limit=100" -o "$CORPO" 2> /dev/null || true
catalogo="$(campo "$CORPO" total_items)"

echo
echo "resumo final: ${lotes} lote(s), items_upserted=${upsertados} somado(s), lote(s) em run concorrente=${concorrentes}"
echo "tempo: ${decorrido}s para ${#selecionadas[@]} chaves (${n_curadas} curadas, ${n_sitemap} do sitemap)"
echo "catalogo: ${catalogo:-n/d} skill(s) (GET ${BASE}/api/v1/skills?limit=100)"

if [ "$upsertados" -eq 0 ]; then
  if [ "$concorrentes" -gt 0 ]; then
    echo "ERRO: nenhum lote gravou (${concorrentes} em run concorrente); o catalogo pode ter crescido por outro run — confira antes de repetir" >&2
  else
    echo "ERRO: nenhum item foi gravado em ${lotes} lote(s); o catalogo nao mudou" >&2
  fi
  exit 1
fi
