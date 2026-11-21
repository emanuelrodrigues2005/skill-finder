#!/usr/bin/env bash
# deploy-now.sh — garante a infra de pé e dispara o deploy.
#
# Por que existe: entre a sessão do lab expirar e o deploy rodar, a instância pode
# ter sido encerrada pelo Academy. Disparar sem conferir gasta um run inteiro para
# o `gate` reprovar em 12 s.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1
R=emanuelrodrigues2005/skill-finder

echo "== 1. host existe? =="
HOST="$(aws ec2 describe-instances \
  --filters "Name=tag:project,Values=skill-finder" "Name=instance-state-name,Values=running,pending" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]' --output text 2>&1)"
if [ -z "$HOST" ]; then
  echo "  nenhum host: aplicando a infra"
  terraform -chdir=infra init -reconfigure \
    -backend-config="bucket=bcc-cloud-tfstate-794399909334" -input=false >/dev/null 2>&1
  terraform -chdir=infra apply -auto-approve -var-file=terraform.tfvars -no-color > /tmp/ap4.txt 2>&1
  echo "  apply=$?"
  grep -E "Apply complete|Error:" /tmp/ap4.txt | head -3
  HOST="$(aws ec2 describe-instances \
    --filters "Name=tag:project,Values=skill-finder" "Name=instance-state-name,Values=running,pending" \
    --query 'Reservations[].Instances[].[InstanceId,State.Name,PublicIpAddress]' --output text 2>&1)"
fi
echo "  host: ${HOST:-AUSENTE}"
echo "  IP:   $(terraform -chdir=infra output -raw host_public_ip 2>/dev/null)"

echo
echo "== 2. secrets no GitHub =="
gh secret list --repo "$R" 2>&1 | awk '{print "  " $1}'
gh variable list --repo "$R" 2>&1 | awk '{print "  var " $1}'

echo
echo "== 3. disparando o deploy =="
gh workflow run deploy.yml --repo "$R" --ref main 2>&1 | head -2
sleep 20
gh run list --repo "$R" --workflow=deploy.yml --limit 1 \
  --json databaseId,status,headBranch --jq '.[0] | "  run=\(.databaseId) status=\(.status) branch=\(.headBranch)"' 2>&1
