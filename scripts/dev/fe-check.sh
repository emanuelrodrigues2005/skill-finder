#!/usr/bin/env bash
# fe-check.sh — verificacao do frontend (contrato, tipos, higiene).
# O frontend roda no checkout, nao no espelho ext4.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.fe-check.log"
: > "$OUT"

cd "$ROOT"

{
  echo "=== guard de contrato ==="
  node frontend/scripts/check-contract.mjs 2>&1 | tail -4
  echo "guard_exit=$?"

  echo
  echo "=== typecheck ==="
  pnpm --dir frontend typecheck 2>&1 | tail -3
  echo "typecheck_exit=$?"

  echo
  echo "=== lint ==="
  pnpm --dir frontend lint 2>&1 | tail -3
  echo "lint_exit=$?"

  echo
  echo "=== mocks restantes em src/ ==="
  grep -rn 'MOCK_\|loadMock' frontend/src | wc -l

  echo
  echo "=== segredo em src/ ==="
  grep -rn 'LLM_API_KEY\|sk-' frontend/src | wc -l

  echo
  echo "=== rotas internas no cliente ==="
  grep -rn '/admin\|/metrics\|/healthz\|/readyz' frontend/src | wc -l

  echo
  echo "=== arquivos do diff ==="
  git status --short frontend/
} >>"$OUT" 2>&1

echo DONE
