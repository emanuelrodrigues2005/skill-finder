#!/usr/bin/env bash
# check-grafana-login.sh — confirma que o usuario admin do Grafana e o esperado.
#
# Nao tenta autenticar (nao ha curl no harness e a senha nao precisa passar por
# aqui): le a variavel dentro do container, que e o que o Grafana usa no primeiro
# boot, e a pagina de login pela borda.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
echo "URL: http://${ALB}/grafana/login"

ID="$(aws ec2 describe-instances \
  --filters "Name=tag:project,Values=skill-finder" "Name=tag:role,Values=api" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null)"

B64="$(printf '%s\n' \
  'set -uo pipefail' \
  'G="$(docker ps -q --filter name=grafana | head -1)"' \
  '[ -n "$G" ] || { echo "SEM CONTAINER GRAFANA"; exit 1; }' \
  'echo "admin_user: $(docker exec "$G" printenv GF_SECURITY_ADMIN_USER)"' \
  'echo "senha_definida: $(docker exec "$G" sh -c "[ -n \"\$GF_SECURITY_ADMIN_PASSWORD\" ] && echo sim || echo nao")"' \
  'echo "status: $(docker inspect -f "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" "$G")"' \
  | base64 -w0)"

CMD="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --comment check-grafana --timeout-seconds 120 \
  --parameters "commands=[\"echo $B64 | base64 -d > /tmp/g.sh && bash /tmp/g.sh\"]" \
  --query 'Command.CommandId' --output text 2>&1)"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" 2>/dev/null
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query 'StandardOutputContent' --output text 2>&1
