#!/usr/bin/env bash
# rehearse-f7.sh — a janela da F7.10: aplica, implanta, verifica e destroi.
#
# Ordem obrigatoria e por que:
#   1. apply antes do deploy, porque o deploy resolve os hosts por tag e precisa
#      do ALB para o smoke.
#   2. deploy com `-f provision=true` quando a infra ja existe e no-op; usar o
#      workflow garante que o caminho exercitado e o do pipeline, nao um atalho.
#   3. verificacao pela URL do ALB — a mesma que a banca vai abrir.
#   4. destroy SEMPRE, inclusive se algo falhar no meio: recurso orfao em conta de
#      laboratorio consome credito ate o fim do semestre.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
REPO="emanuelrodrigues2005/skill-finder"
INICIO=$(date +%s)

limpar() {
  echo
  echo "== destroy =="
  terraform -chdir=infra destroy -auto-approve -var-file=terraform.tfvars -no-color > /tmp/destroy-f7.txt 2>&1
  echo "destroy=$?"
  grep -E "Destroy complete|Error:" /tmp/destroy-f7.txt | head -5
  echo "== varredura =="
  bash scripts/dev/sweep.sh 2>&1 | sed 's/^/  /'
  local fim; fim=$(date +%s)
  echo "== tempo total: $(( (fim - INICIO) / 60 )) min =="
}
trap limpar EXIT INT TERM

echo "== 0. sessao =="
bash scripts/dev/session-on.sh 2>&1 | tail -2 || { echo "sessao invalida; abortando"; exit 1; }

echo
echo "== 1. apply (35 recursos) =="
terraform -chdir=infra init -reconfigure \
  -backend-config="bucket=bcc-cloud-tfstate-794399909334" -input=false > /tmp/init-f7.txt 2>&1
echo "init=$?"
terraform -chdir=infra apply -auto-approve -var-file=terraform.tfvars -no-color > /tmp/apply-f7.txt 2>&1
echo "apply=$?"
grep -E "Apply complete|Error:" /tmp/apply-f7.txt | head -5
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
echo "alb: ${ALB:-AUSENTE}"
terraform -chdir=infra state list 2>/dev/null | wc -l | sed 's/^/itens no state: /'

echo
echo "== 2. deploy pelo workflow =="
gh workflow run deploy.yml --repo "$REPO" --ref main -f provision=true >/dev/null 2>&1
sleep 25
RUN="$(gh run list --repo "$REPO" --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "run: $RUN"
gh run watch "$RUN" --repo "$REPO" --interval 30 > /tmp/watch-f7.txt 2>&1
# `gh run watch` volta quando um job falha, nao quando o run termina: o `smoke`
# continua tentando a borda. Destruir antes dele acaba deixa o job batendo num ALB
# que nao existe mais e o log dele fica inutil — aconteceu no ensaio de 24/11.
for _ in $(seq 1 40); do
  st="$(gh run view "$RUN" --repo "$REPO" --json status --jq .status 2>/dev/null)"
  [ "$st" = "completed" ] && break
  sleep 20
done
gh run view "$RUN" --repo "$REPO" --json conclusion,jobs --jq '"conclusao: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'

echo
echo "== 3. verificacao pela URL do ALB =="
if [ -n "${ALB:-}" ]; then
  bash scripts/dev/verify-f5.sh "$ALB" 2>&1 | tail -10
else
  echo "sem ALB; pulando"
fi

echo
echo "== 4. prova de identidade (ADR-015) =="
if [ -n "${ALB:-}" ]; then
  for i in $(seq 1 12); do
    printf '%s ' "$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "http://${ALB}/api/v1/search" \
      -H 'content-type: application/json' -H "X-Forwarded-For: 203.0.113.$i" \
      -d '{"query":"skill that reviews pull requests for security"}')"
  done
  echo
fi

echo
echo "== 5. targets saudaveis =="
aws elbv2 describe-target-groups --load-balancer-arn "$(terraform -chdir=infra output -raw alb_arn)" \
  --query 'TargetGroups[].TargetGroupName' --output text 2>&1
aws elbv2 describe-target-health --target-group-arn \
  "$(aws elbv2 describe-target-groups --load-balancer-arn "$(terraform -chdir=infra output -raw alb_arn)" \
     --query 'TargetGroups[?TargetGroupName==`skill-finder-tg-api`].TargetGroupArn' --output text)" \
  --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output text 2>&1
