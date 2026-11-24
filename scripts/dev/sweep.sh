#!/usr/bin/env bash
# sweep.sh — confere que a conta ficou limpa depois do destroy.
#
# Por que existe: `destroy=0` prova que o Terraform terminou, nao que nada sobrou.
# Recurso orfao em conta de laboratorio consome credito ate o fim do semestre.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

echo "state local ....... $(terraform -chdir=infra state list 2>/dev/null | wc -l) itens"
echo "instancias vivas .. $(aws ec2 describe-instances \
  --filters "Name=instance-state-name,Values=running,pending,stopping,stopped" \
            "Name=tag:project,Values=skill-finder" \
  --query 'length(Reservations)' --output text 2>&1)"
echo "volumes .......... $(aws ec2 describe-volumes \
  --filters "Name=tag:project,Values=skill-finder" \
  --query 'length(Volumes)' --output text 2>&1)"
echo "security groups .. $(aws ec2 describe-security-groups \
  --filters "Name=tag:project,Values=skill-finder" \
  --query 'length(SecurityGroups)' --output text 2>&1)"
echo "load balancers ... $(aws elbv2 describe-load-balancers \
  --query 'length(LoadBalancers)' --output text 2>&1)"
echo "target groups .... $(aws elbv2 describe-target-groups \
  --query 'length(TargetGroups)' --output text 2>&1)"
echo "bucket de state .. $(aws s3 ls "s3://bcc-cloud-tfstate-794399909334/projeto2/" 2>&1 | head -1)"
