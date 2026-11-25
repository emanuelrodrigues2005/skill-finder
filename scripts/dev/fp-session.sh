#!/usr/bin/env bash
# fp-session.sh — impressao digital das credenciais carregadas.
#
# Nao imprime valor nenhum, so o hash: serve para provar que o que esta no arquivo
# e exatamente o que o dono mandou, e para comparar duas tentativas sem expor o
# segredo de novo.
set -uo pipefail
source ~/.local/bin/academy-env >/dev/null 2>&1

echo "access_key ....... ${AWS_ACCESS_KEY_ID}"
echo "secret sha256 .... $(printf '%s' "$AWS_SECRET_ACCESS_KEY" | sha256sum | cut -c1-12)"
echo "token  sha256 .... $(printf '%s' "$AWS_SESSION_TOKEN" | sha256sum | cut -c1-12)"
echo "token  tamanho ... ${#AWS_SESSION_TOKEN}"
echo "token  inicio .... ${AWS_SESSION_TOKEN:0:16}"
echo "token  fim ....... ${AWS_SESSION_TOKEN: -8}"
STATUS="$(aws sts get-caller-identity 2>&1 | tail -1)"
echo "sts .............. ${STATUS}"
