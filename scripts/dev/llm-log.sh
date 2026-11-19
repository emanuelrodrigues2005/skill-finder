#!/usr/bin/env bash
# llm-log.sh — mostra o que a API registrou sobre a LLM e o enriquecimento.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1

echo "== linhas relevantes (ultimas 200) =="
docker compose --profile dev logs api-dev --tail 200 --no-color 2>&1 \
  | grep -iE 'llm|enriquec|provider|status=' \
  | tail -25 \
  | sed 's/^/  /'
