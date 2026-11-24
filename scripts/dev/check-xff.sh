#!/usr/bin/env bash
# check-xff.sh — prova a identidade do cliente depois da ADR-015.
#
# O criterio original da issue (#72) era `grep -rn 'x-real-ip' backend/src` = 0,
# e ele estava errado: obrigava a remover tambem a **redacao** do header no log,
# que e justamente o que protege contra o valor forjado. O criterio correto e
# "nenhum USO do header para identidade" — a entrada de `redact` pode ficar.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

echo "== usos de x-real-ip fora da redacao (deve ser 0) =="
usos="$(grep -rn 'x-real-ip' backend/src 2>/dev/null | grep -v 'pino-options' | wc -l)"
echo "  usos: ${usos}"

echo "== o header segue redigido no log? =="
if grep -q 'x-real-ip' backend/src/common/logging/pino-options.ts; then
  echo "  OK    redigido (o valor forjado nao entra no log)"
else
  echo "  FALHA nao esta no redact: o header chega do cliente sem filtro"
fi

echo "== resolveClientIp le qual fonte? =="
grep -n "resolveClientIp" -A6 backend/src/search/client-hash.ts | head -12

echo
if [ "$usos" -eq 0 ]; then
  echo "VEREDITO: identidade nao depende de header do cliente"
else
  echo "VEREDITO: ainda ha uso do header para identidade"
  exit 1
fi
