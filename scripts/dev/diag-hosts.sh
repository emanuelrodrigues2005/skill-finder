#!/usr/bin/env bash
# diag-hosts.sh — o apply recriou? o host tem Docker? o apt alcanca a internet?
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

echo "== o apply terminou? =="
grep -E "Apply complete|Error:" /tmp/rep.txt | head -4

echo
echo "== instancias (role / launch / estado) =="
aws ec2 describe-instances \
  --filters "Name=tag:project,Values=skill-finder" "Name=instance-state-name,Values=running,pending" \
  --query 'Reservations[].Instances[].{role:Tags[?Key==`role`]|[0].Value,launch:LaunchTime,state:State.Name,id:InstanceId}' \
  --output table 2>&1 | head -12

echo
echo "== o host do db alcanca o apt? =="
ID="$(aws ec2 describe-instances \
  --filters "Name=tag:project,Values=skill-finder" "Name=tag:role,Values=db" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null)"
echo "db: ${ID:-AUSENTE}"
if [ -n "${ID:-}" ] && [ "$ID" != "None" ]; then
  CMD="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --comment diag --parameters 'commands=["command -v docker || echo SEM_DOCKER; curl -sS -m 8 -o /dev/null -w apt_http=%{http_code} http://archive.ubuntu.com/ubuntu/dists/noble/InRelease || echo apt_falhou; cloud-init status --long 2>&1 | head -3"]' \
    --query 'Command.CommandId' --output text 2>&1)"
  echo "command: $CMD"
  aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" 2>/dev/null
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
    --query 'StandardOutputContent' --output text 2>&1 | head -12
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
    --query 'StandardErrorContent' --output text 2>&1 | head -6
fi
