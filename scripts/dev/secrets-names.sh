#!/usr/bin/env bash
# secrets-names.sh — lista APENAS os nomes dos segredos do cofre.
#
# Por que existe: a CLI 0.45.x nao mascara o valor de `secrets get` (achado da #19),
# e um copiar/colar de terminal vira vazamento. Este script corta a coluna do valor
# antes de qualquer coisa chegar a tela ou ao log.
set -uo pipefail
PROJ="${1:-2af53052-6e7a-4e59-a321-4525fa7fadae}"
ENV="${2:-prod}"

infisical secrets-manager secrets get --projectId "$PROJ" --env "$ENV" 2>/dev/null \
  | sed 's/│/|/g' \
  | awk -F'|' 'NF>2 { gsub(/^[ \t]+|[ \t]+$/, "", $2); if ($2 != "" && $2 != "SECRET NAME") print $2 }'
