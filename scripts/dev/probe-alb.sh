#!/usr/bin/env bash
# probe-alb.sh — prova se a conta pode CRIAR um ALB, sem criar nada.
#
# Nao existe `--dry-run` no `elbv2 create-load-balancer`. O truque: chamar com
# parametros invalidos. Se a resposta for erro de validacao, a permissao esta
# presente (o servico avaliou o pedido). Se for UnauthorizedOperation/AccessDenied,
# esta negada. Nenhum recurso e criado em nenhum dos dois casos.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

saida="$(aws elbv2 create-load-balancer --name "" --subnets "" 2>&1)"
echo "resposta: ${saida:0:200}"

case "$saida" in
  *UnauthorizedOperation*|*AccessDenied*|*"not authorized"*|*"explicit deny"*)
    echo "VEREDITO: criar ALB NEGADO" ;;
  *ValidationError*|*InvalidParameter*|*"must contain"*|*"at least"*)
    echo "VEREDITO: criar ALB PERMITIDO (erro de validacao = a permissao passou)" ;;
  *)
    echo "VEREDITO: INCONCLUSIVO" ;;
esac
