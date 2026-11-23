#!/usr/bin/env bash
# refresh-aws-secrets.sh — publica as 3 credenciais da sessao nos secrets do repo.
#
# Existe porque o `gate` do deploy usa os secrets do GitHub, nao o `academy-env`.
# Quando a sessao roda, os dois precisam ser atualizados; esquecer um deles custa
# um run inteiro reprovado em 12 s.
#
# Uso:
#   source ~/.local/bin/academy-env
#   bash scripts/dev/refresh-aws-secrets.sh
set -uo pipefail
REPO="${REPO:-emanuelrodrigues2005/skill-finder}"
FALHAS=0

for VAR in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  VALOR="${!VAR:-}"
  if [ -z "$VALOR" ]; then
    printf '  %s: VAZIO no ambiente\n' "$VAR"
    FALHAS=$((FALHAS + 1))
    continue
  fi
  if gh secret set "$VAR" --repo "$REPO" --body "$VALOR" >/dev/null 2>&1; then
    printf '  %s: ok (%s chars)\n' "$VAR" "${#VALOR}"
  else
    printf '  %s: FALHOU\n' "$VAR"
    FALHAS=$((FALHAS + 1))
  fi
done

echo
if [ "$FALHAS" -gt 0 ]; then
  echo "pendências: $FALHAS"
  exit 1
fi
echo "pronto: 3 secrets da sessao atualizados"
