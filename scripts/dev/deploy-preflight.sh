#!/usr/bin/env bash
# deploy-preflight.sh — responde "dá para implantar agora?" antes do dispatch.
#
# Roda as mesmas checagens do job `gate` de `.github/workflows/deploy.yml`:
#
#   1. arquivos que o workflow consome
#   2. invariantes do próprio deploy.yml (gate, SSM, sem SSH, sem tag móvel)
#   3. ferramentas locais
#   4. sessão do Academy, ECR, host de pé e agente SSM online
#   5. secrets do repositório no GitHub
#
# Todo item que falta sai com o comando que resolve; o código de saída é 1 quando
# algo impede o deploy, para o comando poder ser usado num `&&`.
#
#   bash scripts/dev/deploy-preflight.sh            # checagem completa
#   bash scripts/dev/deploy-preflight.sh --offline  # sem AWS e sem gh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 2

MODE=online
for arg in "$@"; do
  case "$arg" in
    --offline) MODE=offline ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "argumento desconhecido: $arg (use --offline ou --help)" >&2
      exit 2
      ;;
  esac
done

WORKFLOW=".github/workflows/deploy.yml"
PROJECT_NAME="${PROJECT_NAME:-skill-finder}"
falhas=0
avisos=0

ok() { printf '  ok     %s\n' "$*"; }
falta() {
  printf '  FALTA  %s\n' "$*"
  falhas=$((falhas + 1))
}
aviso() {
  printf '  aviso  %s\n' "$*"
  avisos=$((avisos + 1))
}

echo "1. arquivos"
for arquivo in "$WORKFLOW" .github/workflows/ci.yml compose.yaml infra/deploy/compose.prod.yaml infra/versions.tf; do
  if [ -f "$arquivo" ]; then
    ok "$arquivo"
  else
    falta "$arquivo ausente (rode da raiz do repositório)"
  fi
done

echo "2. invariantes do deploy.yml"
regra() { # regra <descricao> <padrao ERE> <presente|ausente> <como corrigir>
  local descricao="$1" padrao="$2" esperado="$3" correcao="$4" achou=nao
  grep -qE "$padrao" "$WORKFLOW" && achou=sim
  if { [ "$esperado" = presente ] && [ "$achou" = sim ]; } || { [ "$esperado" = ausente ] && [ "$achou" = nao ]; }; then
    ok "$descricao"
  else
    falta "$descricao — $correcao"
  fi
}

if [ -f "$WORKFLOW" ]; then
  regra "gate de testes por workflow_run do ci.yml" 'workflow_run:' presente "o deploy tem de nascer do CI verde"
  regra "workflow_dispatch para o deploy manual" 'workflow_dispatch:' presente "sem ele não há rollback nem provisionamento sob demanda"
  regra "concurrency declarada" '^concurrency:' presente "dois deploys simultâneos corrompem o host"
  regra "permissions explícitas" '^permissions:' presente "sem bloco, o token herda o default do repositório"
  regra "credencial mascarada antes de usar" '::add-mask::' presente "segredo em log é vazamento"
  regra "smoke de /healthz" '/healthz' presente "o requisito do §3.3 é a disponibilidade verificada"
  regra "smoke de /readyz" '/readyz' presente "sem ele o smoke não vê o banco fora"
  regra "smoke da ingestão sem token (401)" '"401"' presente "a rota admin não pode aceitar chamada anônima"
  regra "migração pelo npm na imagem runtime" 'npm run --silent prisma:deploy' presente "a imagem runtime não tem scripts/ nem ts-node"
  regra "sem SSH" '(^|[^a-z])ssh([^a-z]|$)' ausente "o canal é o SSM; a porta 22 não existe"
  regra "sem pnpm prisma:deploy" 'pnpm prisma:deploy' ausente "use npm: o runtime não tem o pnpm do repositório"
  regra "sem tag móvel latest" '(:latest|@latest)' ausente "tag móvel torna o deploy irreprodutível"

  jobs="$(awk '/^jobs:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [a-z_-]+:$/{n++} END{print n+0}' "$WORKFLOW")"
  timeouts="$(awk '/^jobs:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^    timeout-minutes:/{n++} END{print n+0}' "$WORKFLOW")"
  if [ "${jobs:-0}" -ge 1 ] && [ "${timeouts:-0}" -ge "${jobs:-0}" ]; then
    ok "timeout-minutes em ${timeouts}/${jobs} jobs"
  else
    falta "timeout-minutes em ${timeouts:-0}/${jobs:-0} jobs — job sem prazo trava a fila"
  fi

  # IP público no workflow: o do host muda a cada stop/start e o da conta não é
  # dado do repositório. Loopback (`localhost`) é legítimo.
  ips="$(grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}' "$WORKFLOW" | grep -vE '127\.0\.0\.1|0\.0\.0\.0' || true)"
  if [ -z "$ips" ]; then
    ok "nenhum IP literal de host no deploy.yml"
  else
    printf '%s\n' "$ips"
    falta "IP literal no deploy.yml — o host muda de IP a cada stop/start, leia da AWS"
  fi
fi

echo "3. ferramentas"
for ferramenta in git jq aws; do
  if command -v "$ferramenta" >/dev/null 2>&1; then
    ok "$ferramenta"
  else
    falta "$ferramenta ausente (scripts/install-toolchain-wsl.sh)"
  fi
done
for opcional in docker terraform gh; do
  if command -v "$opcional" >/dev/null 2>&1; then
    ok "$opcional"
  else
    aviso "$opcional ausente (necessário só para build local, provision ou checagem de secrets)"
  fi
done

if [ "$MODE" = offline ]; then
  echo "4. sessão do Academy e infraestrutura"
  aviso "checagem de AWS pulada (--offline)"
  echo "5. secrets do repositório"
  aviso "checagem do GitHub pulada (--offline)"
else
  echo "4. sessão do Academy e infraestrutura"
  credencial=ok
  for var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
    if [ -n "${!var:-}" ]; then
      ok "$var definido"
    else
      falta "$var vazio (source ~/.local/bin/academy-env)"
      credencial=falta
    fi
  done

  if [ "$credencial" = ok ] && command -v aws >/dev/null 2>&1; then
    if ! account="$(aws sts get-caller-identity --query Account --output text 2>&1)"; then
      falta "credencial recusada pela AWS: ${account} (renove a sessão do lab)"
      credencial=falta
    else
      ok "conta ${account}"
    fi
  fi

  if [ "$credencial" = ok ]; then
    if aws ecr describe-repositories --repository-names "${PROJECT_NAME}-api" "${PROJECT_NAME}-web" >/dev/null 2>&1; then
      ok "repositórios ${PROJECT_NAME}-api e ${PROJECT_NAME}-web no ECR"
    else
      falta "ECR sem os dois repositórios — a infra da F3 não está de pé (runbook §1 ou provision=true)"
    fi

    instancias="$(aws ec2 describe-instances \
      --filters "Name=tag:project,Values=${PROJECT_NAME}" "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress]' --output text 2>/dev/null || true)"
    if [ -z "$instancias" ]; then
      falta "nenhuma instância 'running' com tag project=${PROJECT_NAME} (runbook §1 ou §4.2)"
    else
      primeira="$(printf '%s\n' "$instancias" | head -1)"
      ok "host $(printf '%s' "$primeira" | cut -f1) em $(printf '%s' "$primeira" | cut -f2)"
      instance_id="$(printf '%s' "$primeira" | cut -f1)"
      ping="$(aws ssm describe-instance-information \
        --filters "Key=InstanceIds,Values=${instance_id}" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
      if [ "$ping" = "Online" ]; then
        ok "agente SSM Online na instância"
      else
        falta "agente SSM '${ping:-ausente}': o deploy não tem outro canal (systemctl status amazon-ssm-agent no host)"
      fi
    fi
  else
    aviso "ECR, host e SSM não checados: a credencial falhou antes"
  fi

  echo "5. secrets do repositório"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    nomes="$(gh secret list --json name --jq '.[].name' 2>/dev/null || true)"
    if [ -z "$nomes" ]; then
      aviso "não consegui listar os secrets (o papel no repositório precisa ser admin)"
    else
      for secret in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
        if printf '%s\n' "$nomes" | grep -qx "$secret"; then
          ok "secret $secret"
        else
          falta "secret $secret no GitHub — gh secret set $secret"
        fi
      done
    fi
  else
    aviso "gh ausente ou sem login: 'gh auth login' libera a checagem dos secrets"
  fi
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "pronto: nenhuma pendência (${avisos} aviso(s))"
  exit 0
fi
echo "pendente: ${falhas} item(ns) a resolver, ${avisos} aviso(s)"
echo "o job 'gate' do deploy.yml reprova no mesmo ponto; nada foi executado aqui."
exit 1
