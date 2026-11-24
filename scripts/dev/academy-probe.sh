#!/usr/bin/env bash
# academy-probe.sh — o que o laboratorio permite para uma arquitetura de varias VMs + ALB.
#
# Por que existe: o plano de `docs/02` foi escrito antes de a arquitetura avancada ser
# considerada, e "ALB/RDS/multi-VM" estava marcado como risco sem medicao. Cada linha
# aqui responde com permissao real, nao com suposicao — e o resultado vira ADR.
set -uo pipefail
cd /mnt/c/Users/Lima02/Documents/bcc/cloud || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ok()   { printf '  OK    %s\n' "$1"; }
nao()  { printf '  NAO   %s\n' "$1"; }
info() { printf '  --    %s\n' "$1"; }

echo "== identidade =="
info "conta: $(aws sts get-caller-identity --query Account --output text 2>&1)"

echo
echo "== rede disponivel =="
info "subnets default: $(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'length(Subnets)' --output text 2>&1)"
info "AZs: $(aws ec2 describe-availability-zones --query 'length(AvailabilityZones)' --output text 2>&1)"
info "VPC default: $(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text 2>&1)"

echo
echo "== ALB (elbv2) =="
if albs="$(aws elbv2 describe-load-balancers --query 'length(LoadBalancers)' --output text 2>&1)"; then
  ok "describe-load-balancers (existentes: ${albs})"
else
  nao "describe-load-balancers: ${albs:0:120}"
fi
if alvo="$(aws elbv2 describe-target-groups --query 'length(TargetGroups)' --output text 2>&1)"; then
  ok "describe-target-groups (existentes: ${alvo})"
else
  nao "describe-target-groups: ${alvo:0:120}"
fi
# DryRun prova permissao de escrita sem criar nada e sem custo.
saida="$(aws elbv2 create-load-balancer --name probe-dryrun --subnets "$(aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query 'Subnets[0].SubnetId' --output text 2>/dev/null)" --dry-run 2>&1)"
case "$saida" in
  *DryRunOperation*) ok "create-load-balancer: permissao presente (dry-run respondeu DryRunOperation)" ;;
  *UnauthorizedOperation*|*AccessDenied*) nao "create-load-balancer NEGADO: ${saida:0:140}" ;;
  *) info "create-load-balancer: resposta inesperada: ${saida:0:140}" ;;
esac

echo
echo "== RDS (o banco gerenciado) =="
if grupos="$(aws rds describe-db-subnet-groups --query 'length(DBSubnetGroups)' --output text 2>&1)"; then
  ok "describe-db-subnet-groups (existentes: ${grupos})"
  if [ "${grupos:-0}" = "0" ]; then
    nao "sem DB subnet group -> RDS nao cria (K14 de docs/02 confirmado)"
  fi
else
  nao "describe-db-subnet-groups: ${grupos:0:120}"
fi

echo
echo "== compute =="
for tipo in t3.micro t3.small t3.medium; do
  if aws ec2 describe-instance-types --instance-types "$tipo" --query "InstanceTypes[0].InstanceType" --output text >/dev/null 2>&1; then
    ok "$tipo disponivel"
  else
    nao "$tipo indisponivel"
  fi
done
info "instancias vivas hoje: $(aws ec2 describe-instances --filters Name=instance-state-name,Values=running,pending --query 'length(Reservations)' --output text 2>&1)"

echo
echo "== Route 53 (DNS proprio) =="
if zonas="$(aws route53 list-hosted-zones --query 'length(HostedZones)' --output text 2>&1)"; then
  ok "list-hosted-zones (zonas: ${zonas})"
else
  nao "list-hosted-zones: ${zonas:0:120}"
fi

echo
echo "== custo potencial (referencia de docs/02) =="
info "ALB cobra por hora mesmo ocioso; 3 x t3.micro + ALB + EBS de 20 GiB"
info "credito do laboratorio: \$50 para o semestre"
