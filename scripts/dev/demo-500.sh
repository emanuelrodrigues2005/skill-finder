#!/usr/bin/env bash
# demo-500.sh — acende o painel "Logs de erro da API" com um 5xx real e desfaz.
#
# Por que existe: o painel filtra `level="error"`, e o logger so marca `error` em
# 5xx (pino-options.ts:101-106). Um 422 e `warn` e nao aparece la.
#
# O caminho: parar o Postgres por ~15 s, chamar a busca (5xx), provar a linha no
# Loki e SUBIR o banco de novo. O religamento esta num trap, que roda mesmo se o
# meio falhar: deixar o banco parado e o unico desfecho inaceitavel.
#
# `--parameters commands="..."` (shorthand) evita o JSON com aspas aninhadas que
# quebrou as tentativas anteriores no shell do WSL.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
source ~/.local/bin/academy-env >/dev/null 2>&1

REGIAO=us-east-1
DB_ID="${SF_DB_ID:-i-0b3e172230f0117ba}"
ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
BASE="http://${ALB}"
echo "banco: ${DB_ID}"
echo "API:   ${BASE}"

# Roda um comando na VM do banco e espera terminar; imprime a saida.
rodar() {
  local id
  id="$(aws ssm send-command --region "$REGIAO" --instance-ids "$DB_ID" \
    --document-name AWS-RunShellScript --parameters "commands=$1" \
    --query "Command.CommandId" --output text 2>/dev/null)"
  if [ -z "${id:-}" ] || [ "$id" = "None" ]; then
    echo "SSM_FALHOU"
    return 1
  fi
  for _ in $(seq 1 20); do
    sleep 3
    estado="$(aws ssm get-command-invocation --region "$REGIAO" --command-id "$id" \
      --instance-id "$DB_ID" --query "Status" --output text 2>/dev/null)"
    case "$estado" in
      Success)
        aws ssm get-command-invocation --region "$REGIAO" --command-id "$id" \
          --instance-id "$DB_ID" --query "StandardOutputContent" --output text 2>/dev/null
        return 0
        ;;
      Failed|Cancelled|TimedOut)
        echo "SSM_ESTADO=${estado}"
        return 1
        ;;
    esac
  done
  echo "SSM_TIMEOUT"
  return 1
}

CONTAINER=""

subir() {
  echo
  echo "== religando o Postgres =="
  [ -n "${CONTAINER:-}" ] && rodar "docker start ${CONTAINER}" >/dev/null 2>&1
  for _ in $(seq 1 20); do
    codigo="$(curl -sS -o /dev/null -w '%{http_code}' -m 10 "${BASE}/readyz" 2>/dev/null)"
    if [ "$codigo" = "200" ]; then
      echo "  /readyz 200 - banco no ar"
      return 0
    fi
    sleep 5
  done
  echo "  AVISO: /readyz nao voltou a 200 - verificar manualmente" >&2
}
trap subir EXIT INT TERM

echo
echo "== container do banco =="
CONTAINER="$(rodar 'docker ps -aq --filter name=postgres | head -1' | tr -d '[:space:]')"
echo "  ${CONTAINER:-NAO_ENCONTRADO}"
[ -z "$CONTAINER" ] && { echo "FALHA: sem container postgres" >&2; exit 1; }

echo
echo "== parando =="
rodar "docker stop ${CONTAINER}" >/dev/null

echo
echo "== chamando a busca (espera-se 5xx) =="
status="$(curl -sS -o /tmp/d500.json -w '%{http_code}' -m 40 -X POST "${BASE}/api/v1/search" \
  -H 'content-type: application/json' -H 'X-Forwarded-For: 198.43.40.40' \
  -d '{"query":"erro proposital para a demo","limit":3}' 2>/dev/null)"
echo "  status: ${status}"
head -c 200 /tmp/d500.json 2>/dev/null; echo

echo
echo "== aguardando o Promtail (6 s) =="
sleep 6

echo
echo "== o mesmo LogQL do painel =="
python3 scripts/dev/loki.py 2>&1 | head -6
