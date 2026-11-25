#!/usr/bin/env bash
# recreate-hosts.sh — adiciona o egress 80 e recria as tres instancias.
#
# Por que recriar e nao so aplicar: `user_data` roda no boot e o atributo
# `user_data_replace_on_change` e false. Instancia que ja subiu sem rede nao vai
# instalar o Docker sozinha — precisa nascer de novo, agora com a regra de saida.
#
# O ALB e os SGs ficam: so as instancias sao substituidas, e o Terraform
# re-registra os target group attachments com os ids novos.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

terraform -chdir=infra apply -auto-approve -var-file=terraform.tfvars -no-color \
  -replace='aws_instance.role["web"]' \
  -replace='aws_instance.role["api"]' \
  -replace='aws_instance.role["db"]' > /tmp/rep.txt 2>&1
echo "apply=$?"
grep -E "Apply complete|Error:" /tmp/rep.txt | head -5
echo "state: $(terraform -chdir=infra state list 2>/dev/null | wc -l) itens"

# As tres nascem juntas; o `user_data` leva 1-3 min com rede liberada.
echo "aguardando o user_data (ate 6 min)..."
for i in $(seq 1 36); do
  sleep 10
  echo "  $((i*10))s"
  [ "$i" -ge 18 ] && break
done

echo
echo "== targets =="
ARN="$(terraform -chdir=infra output -raw alb_arn 2>/dev/null)"
for tg in $(aws elbv2 describe-target-groups --load-balancer-arn "$ARN" --query 'TargetGroups[].TargetGroupName' --output text 2>/dev/null); do
  printf '  %-26s ' "$tg"
  aws elbv2 describe-target-health \
    --target-group-arn "$(aws elbv2 describe-target-groups --names "$tg" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)" \
    --query 'TargetHealthDescriptions[].TargetHealth.State' --output text 2>/dev/null
done
