#!/usr/bin/env bash
# set-deploy-secrets.sh — publica as credenciais da sessão do Academy como secrets.
#
# Por que existe: as credenciais do Learner Lab duram ~4 h e o pipeline de deploy
# precisa delas nos `secrets` do repositório. Fazer isso à mão a cada sessão é o
# tipo de passo que se esquece — e o sintoma é o `gate` do deploy falhar dizendo
# "credencial inválida", que não aponta para a causa.
#
# Uso:
#   source ~/.local/bin/academy-env
#   bash scripts/dev/set-deploy-secrets.sh
#
# Nada é impresso além do nome da variável: o valor vai do ambiente para a API do
# GitHub por stdin, nunca por argumento de linha de comando (que aparece em `ps`).
set -uo pipefail

REPO="${REPO:-emanuelrodrigues2005/skill-finder}"
FALHAS=0

for VAR in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  VALOR="${!VAR:-}"
  if [ -z "$VALOR" ]; then
    printf '  %s: VAZIO — rode `source ~/.local/bin/academy-env` antes\n' "$VAR"
    FALHAS=$((FALHAS + 1))
    continue
  fi
  if gh secret set "$VAR" --repo "$REPO" --body "$VALOR" >/dev/null 2>&1; then
    printf '  %s: ok (%s chars)\n' "$VAR" "${#VALOR}"
  else
    printf '  %s: FALHOU (gh autenticado? permissão de admin no repo?)\n' "$VAR"
    FALHAS=$((FALHAS + 1))
  fi
done

echo
echo "secrets no repositório:"
gh secret list --repo "$REPO" 2>&1 | sed 's/^/  /'

echo
if [ "$FALHAS" -gt 0 ]; then
  echo "pendências: $FALHAS"
  exit 1
fi
echo "pronto: 3 secrets publicados"
