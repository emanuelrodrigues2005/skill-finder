#!/usr/bin/env bash
# clean-logs.sh — remove os logs de verificacao gerados no checkout.
#
# Guardas, porque apagar e destrutivo:
#   1. NUNCA apaga arquivo rastreado pelo git (so o que e lixo de execucao);
#   2. ignora node_modules/.git/dist/coverage (nao sao nossos);
#   3. imprime o caminho absoluto resolvido de cada alvo ANTES de apagar;
#   4. recusa alvo fora da raiz do repositorio (`--dry-run` por padrao).
#
# Uso:
#   bash scripts/dev/clean-logs.sh            # so mostra o que apagaria
#   bash scripts/dev/clean-logs.sh --apply    # apaga de fato
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_REAL="$(readlink -f "$ROOT")"
APLICAR=0
[ "${1:-}" = "--apply" ] && APLICAR=1

echo "raiz do repositorio: $ROOT_REAL"
echo

# Logs rastreados: se houver, NAO sao lixo e nao entram na lista.
rastreados="$(cd "$ROOT_REAL" && git ls-files '*log' 2>/dev/null || true)"
if [ -n "$rastreados" ]; then
  echo "ATENCAO — logs RASTREADOS no git (nao serao tocados):"
  printf '%s\n' "$rastreados" | sed 's/^/  /'
  echo
fi

alvos=()
while IFS= read -r arquivo; do
  [ -z "$arquivo" ] && continue
  absoluto="$(readlink -f "$arquivo")"
  # Guarda 4: o alvo tem de estar DENTRO da raiz.
  case "$absoluto" in
    "$ROOT_REAL"/*) ;;
    *) echo "  RECUSADO (fora da raiz): $absoluto"; continue ;;
  esac
  # Guarda 1: nada rastreado.
  relativo="${absoluto#"$ROOT_REAL"/}"
  if git -C "$ROOT_REAL" ls-files --error-unmatch "$relativo" >/dev/null 2>&1; then
    echo "  RECUSADO (rastreado): $relativo"
    continue
  fi
  alvos+=("$absoluto")
done < <(
  find "$ROOT_REAL" \
    -path "$ROOT_REAL/node_modules" -prune -o \
    -path "$ROOT_REAL/backend/node_modules" -prune -o \
    -path "$ROOT_REAL/frontend/node_modules" -prune -o \
    -path "$ROOT_REAL/.git" -prune -o \
    -path "*/dist" -prune -o \
    -path "*/coverage" -prune -o \
    -type f -name '*.log' -print 2>/dev/null
)

echo "logs nao rastreados encontrados: ${#alvos[@]}"
total=0
for alvo in "${alvos[@]}"; do
  tamanho="$(stat -c%s "$alvo" 2>/dev/null || echo 0)"
  total=$((total + tamanho))
  printf '  %8s B  %s\n' "$tamanho" "${alvo#"$ROOT_REAL"/}"
done
echo
printf 'total: %s bytes\n' "$total"

if [ "${#alvos[@]}" -eq 0 ]; then
  echo "nada a apagar"
  exit 0
fi

if [ "$APLICAR" -eq 0 ]; then
  echo
  echo "modo diagnostico: nada foi apagado. Rode com --apply para remover."
  exit 0
fi

apagados=0
for alvo in "${alvos[@]}"; do
  rm -f -- "$alvo" && apagados=$((apagados + 1))
done
echo
echo "apagados: $apagados de ${#alvos[@]}"
