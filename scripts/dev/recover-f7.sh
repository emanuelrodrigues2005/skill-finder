#!/usr/bin/env bash
# recover-f7.sh — reconcilia a sessao nova com o state antigo e sobe tudo.
#
# Por que nao e so `apply`: quando o Academy encerra a sessao, ele **termina** as
# instancias e o ALB. O state no S3 continua descrevendo recursos que nao existem
# mais, entao o primeiro passo e um `plan` que mostra o estrago — e o `apply`
# recria o que sumiu em vez de falhar no refresh.
#
# Deixa no ar (sem `destroy`): o dono pediu para testar.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
REPO="emanuelrodrigues2005/skill-finder"

echo "== 0. sessao =="
bash scripts/dev/session-on.sh 2>&1 | tail -2 || { echo "sessao invalida; abortando"; exit 1; }

echo
echo "== 1. o que sobrou da sessao anterior =="
bash scripts/dev/sweep.sh 2>&1 | sed 's/^/  /'

echo
echo "== 2. plan (reconcilia o state com a realidade) =="
terraform -chdir=infra init -reconfigure \
  -backend-config="bucket=bcc-cloud-tfstate-794399909334" -input=false > /tmp/rc-init.txt 2>&1
echo "init=$?"
terraform -chdir=infra plan -no-color -var-file=terraform.tfvars > /tmp/rc-plan.txt 2>&1
echo "plan=$?"
grep -E "^Plan:" /tmp/rc-plan.txt

echo
echo "== 3. apply =="
terraform -chdir=infra apply -auto-approve -var-file=terraform.tfvars -no-color > /tmp/rc-apply.txt 2>&1
echo "apply=$?"
grep -E "Apply complete|Error:" /tmp/rc-apply.txt | head -5
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
echo "alb: ${ALB:-AUSENTE}"

echo
echo "== 4. deploy pelo pipeline =="
gh workflow run deploy.yml --repo "$REPO" --ref main -f provision=true >/dev/null 2>&1
sleep 25
RUN="$(gh run list --repo "$REPO" --workflow=deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo "run: $RUN"
for _ in $(seq 1 100); do
  st="$(gh run view "$RUN" --repo "$REPO" --json status --jq .status 2>/dev/null)"
  [ "$st" = "completed" ] && break
  sleep 20
done
gh run view "$RUN" --repo "$REPO" --json conclusion,jobs \
  --jq '"conclusao: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'

echo
echo "== 5. verificacao pela borda =="
[ -n "${ALB:-}" ] && bash scripts/dev/verify-f5.sh "$ALB" 2>&1 | tail -10

echo
echo "================================================================"
echo "  URL: http://${ALB}"
echo "  Grafana: http://${ALB}/grafana/  (ejtr2005)"
echo "  No ar por decisao do dono — sem destroy."
echo "================================================================"
