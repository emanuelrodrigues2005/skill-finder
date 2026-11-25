#!/usr/bin/env bash
# bringup-f7.sh — sobe a arquitetura distribuida e deixa no ar.
#
# Diferente do `rehearse-f7.sh`: **nao destroi** no fim. O dono pediu as maquinas
# de pe para testar, e o custo (0,1147/h) e aceito por ele. O comando de destruicao
# sai impresso no final, junto com a varredura que prova que nada sobrou quando
# for a hora.
#
# Nao ha `trap` de destroy de proposito: um `trap` que apaga ao sair e exatamente
# o que nao se quer aqui. Se algo falhar no meio, o script para e diz o que fazer —
# deixar recurso pela metade e melhor que apagar o que ja subiu.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
REPO="emanuelrodrigues2005/skill-finder"

echo "== 0. sessao =="
bash scripts/dev/session-on.sh 2>&1 | tail -2 || { echo "sessao invalida; abortando"; exit 1; }

echo
echo "== 1. apply =="
terraform -chdir=infra init -reconfigure \
  -backend-config="bucket=bcc-cloud-tfstate-794399909334" -input=false > /tmp/bi-init.txt 2>&1
echo "init=$?"
terraform -chdir=infra apply -auto-approve -var-file=terraform.tfvars -no-color > /tmp/bi-apply.txt 2>&1
echo "apply=$?"
grep -E "Apply complete|Error:" /tmp/bi-apply.txt | head -5
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
echo "alb: ${ALB:-AUSENTE}"
echo "state: $(terraform -chdir=infra state list 2>/dev/null | wc -l) itens"

echo
echo "== 2. deploy pelo pipeline =="
gh workflow run deploy.yml --repo "$REPO" --ref main -f provision=true >/dev/null 2>&1
sleep 25
RUN="$(gh run list --repo "$REPO" --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "run: $RUN"
for _ in $(seq 1 90); do
  st="$(gh run view "$RUN" --repo "$REPO" --json status --jq .status 2>/dev/null)"
  [ "$st" = "completed" ] && break
  sleep 20
done
gh run view "$RUN" --repo "$REPO" --json conclusion,jobs \
  --jq '"conclusao: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
gh run view "$RUN" --repo "$REPO" --json jobs \
  --jq '.jobs[] | select(.name=="deploy") | .steps[] | select(.conclusion=="failure") | "  PASSO QUE FALHOU: \(.name)"'

echo
echo "== 3. verificacao pela borda =="
if [ -n "${ALB:-}" ]; then
  bash scripts/dev/verify-f5.sh "$ALB" 2>&1 | tail -10
fi

echo
echo "== 4. targets =="
if [ -n "${ALB:-}" ]; then
  ARN="$(terraform -chdir=infra output -raw alb_arn 2>/dev/null)"
  for tg in $(aws elbv2 describe-target-groups --load-balancer-arn "$ARN" --query 'TargetGroups[].TargetGroupName' --output text 2>/dev/null); do
    printf '  %-24s ' "$tg"
    aws elbv2 describe-target-health \
      --target-group-arn "$(aws elbv2 describe-target-groups --names "$tg" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)" \
      --query 'TargetHealthDescriptions[].TargetHealth.State' --output text 2>/dev/null
  done
fi

echo
echo "================================================================"
echo "  NO AR — nao destruido, por pedido do dono"
echo "  URL: http://${ALB}"
echo "  Custo: 0,1147 US\$/h (~R\$ 0,62/h)"
echo
echo "  Para derrubar quando terminar de testar:"
echo "    terraform -chdir=infra destroy -var-file=terraform.tfvars"
echo "    bash scripts/dev/sweep.sh"
echo "================================================================"
