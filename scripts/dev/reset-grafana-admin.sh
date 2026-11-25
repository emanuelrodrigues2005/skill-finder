#!/usr/bin/env bash
# reset-grafana-admin.sh — apaga o volume do Grafana para o par usuario/senha ser
# semeado de novo pelo ambiente.
#
# Por que e necessario: o Grafana grava o usuario admin no banco dele, dentro do
# volume `grafana-data`. `GF_SECURITY_ADMIN_USER`/`_PASSWORD` so valem no primeiro
# boot; com o volume existente, trocar a variavel nao muda nada.
#
# O que se perde: apenas estado local do Grafana (preferencias de UI, usuarios
# criados). Os dashboards vem de `observability/grafana/dashboards/main.json`,
# provisionados por arquivo, e o datasource tambem.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

ID="$(aws ec2 describe-instances \
  --filters "Name=tag:project,Values=skill-finder" "Name=tag:role,Values=api" \
            "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null)"
echo "api: ${ID:-AUSENTE}"
[ -n "${ID:-}" ] && [ "$ID" != "None" ] || { echo "sem instancia api; abortando" >&2; exit 1; }

cat > /tmp/reset-grafana.sh <<'REMOTE'
set -uo pipefail
cd /opt/app || exit 1
echo "== volumes antes =="
docker volume ls --format '{{.Name}}' | grep -i grafana || echo "  (nenhum)"
# O `compose down` precisa de `DOCKERHUB_USER` e do `GRAFANA_PASSWORD` (o override
# usa `:?`), e este script roda fora do Infisical. Remover o container direto evita
# a interpolacao e e o suficiente: quem usa o volume e so o grafana.
echo "== removendo o container do grafana =="
for c in $(docker ps -aq --filter "name=grafana"); do
  echo "  docker rm -f $c"
  docker rm -f "$c" 2>&1
done
echo "== removendo o volume do grafana =="
for v in $(docker volume ls --format '{{.Name}}' | grep -i 'grafana-data'); do
  echo "  removendo $v"
  docker volume rm "$v" 2>&1
done
echo "== volumes depois =="
docker volume ls --format '{{.Name}}' | grep -i grafana || echo "  (nenhum)"
REMOTE

CMD="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --comment reset-grafana-admin --timeout-seconds 300 \
  --parameters file:///tmp/reset-grafana-params.json \
  --query 'Command.CommandId' --output text 2>/dev/null)"
if [ -z "${CMD:-}" ]; then
  # fallback: manda o script em base64 dentro de um unico comando
  B64="$(base64 -w0 /tmp/reset-grafana.sh)"
  CMD="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --comment reset-grafana-admin --timeout-seconds 300 \
    --parameters "commands=[\"echo $B64 | base64 -d > /tmp/r.sh && bash /tmp/r.sh\"]" \
    --query 'Command.CommandId' --output text 2>&1)"
fi
echo "command: $CMD"
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" 2>/dev/null
echo "== saida =="
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query 'StandardOutputContent' --output text 2>&1
echo "== erros =="
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query 'StandardErrorContent' --output text 2>&1 | head -10
