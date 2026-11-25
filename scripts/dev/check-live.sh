#!/usr/bin/env bash
# check-live.sh — verifica a aplicacao viva pela URL do ALB e os target groups.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
echo "URL: http://${ALB}"
echo
bash scripts/dev/verify-f5.sh "$ALB" 2>&1 | tail -10

echo
echo "== targets =="
ARN="$(terraform -chdir=infra output -raw alb_arn 2>/dev/null)"
for tg in $(aws elbv2 describe-target-groups --load-balancer-arn "$ARN" --query 'TargetGroups[].TargetGroupName' --output text 2>/dev/null); do
  printf '  %-26s ' "$tg"
  aws elbv2 describe-target-health \
    --target-group-arn "$(aws elbv2 describe-target-groups --names "$tg" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)" \
    --query 'TargetHealthDescriptions[].TargetHealth.State' --output text 2>/dev/null
done
