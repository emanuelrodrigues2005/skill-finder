#!/usr/bin/env bash
# =============================================================================
# sandbox-check.sh — valida o sandbox do AWS Academy em uma sessão de lab
#
# Roda os itens K de docs/02-aws-academy-limites-e-riscos.md §11 que NÃO exigem
# infraestrutura: identidade, região, key pair, IAM pré-existente, ECR, S3, RDS,
# tipos de instância e cotas. Tudo com limpeza automática do que cria.
#
# Uso (dentro do Ubuntu, na raiz do repositório):
#   source ~/.local/bin/academy-env      # as 3 credenciais da sessão
#   bash scripts/sandbox-check.sh
#   bash scripts/sandbox-check.sh --com-iam   # inclui o teste de OIDC (write em IAM)
#
# Saída: tabela no terminal + registro datado em docs/evidencias/sandbox.md
#
# É seguro rodar de novo: nomes de bucket/recurso são únicos por execução e tudo
# que este script cria é removido no fim (inclusive em caso de erro).
# =============================================================================
set -uo pipefail   # sem -e de propósito: várias verificações FALHAM por design

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVID="$ROOT/docs/evidencias"
LOG_MD="$EVID/sandbox.md"
COM_IAM=0

for arg in "$@"; do
  case "$arg" in
    --com-iam) COM_IAM=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg (use --help)" >&2; exit 2 ;;
  esac
done

# ---------- apresentação ---------------------------------------------------
B=$'\033[1m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; N=$'\033[0m'
declare -a ROWS=()
FAIL=0

row() { # k, pergunta, estado(OK/FALHA/N/A/INCONCLUSIVO), detalhe
  local k="$1" q="$2" st="$3" det="$4"
  local color="$G"
  case "$st" in
    FALHA) color="$R"; FAIL=$((FAIL+1)) ;;
    N/A)   color="$Y" ;;
    INCONCLUSIVO) color="$Y" ;;
  esac
  printf '%s%-3s%s %-46s %s%-13s%s %s\n' "$B" "$k" "$N" "$q" "$color" "$st" "$N" "$det"
  ROWS+=("| $k | $(date +%Y-%m-%d) | $q | $st | ${det//|/\\|} |")
}

# ---------- 0. credenciais -------------------------------------------------
echo
echo "${B}=== sandbox-check — AWS Academy Learner Lab ===${N}"
echo

if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
  printf '%sFALHA%s AWS_SESSION_TOKEN não está definido.\n' "$R" "$N"
  echo "       Rode: source ~/.local/bin/academy-env"
  exit 1
fi

ACCOUNT=""
ARN=""
if out=$(aws sts get-caller-identity --query '[Arn,Account]' --output text 2>&1); then
  ARN="$(echo "$out" | awk '{print $1}')"
  ACCOUNT="$(echo "$out" | awk '{print $2}')"
  SESSION_ROLE="$(echo "$ARN" | sed -nE 's#.*:assumed-role/([^/]+)/.*#\1#p')"
  case "$ARN" in
    *:assumed-role/*) row K1 "credenciais validas (sts get-caller-identity)" OK "role de sessao = ${SESSION_ROLE:-?}" ;;
    *)                row K1 "credenciais validas (sts get-caller-identity)" OK "ARN de usuario (Cenario B)" ;;
  esac
else
  row K1 "credenciais validas (sts get-caller-identity)" FALHA "$(echo "$out" | head -n1)"
  echo "${R}Sem credencial válida nada mais faz sentido.${N}"
  exit 1
fi

REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-}}"
if [ -z "$REGION" ]; then
  REGION="$(aws configure get region 2>/dev/null || true)"
fi
if [ -n "$REGION" ]; then
  row K2 "regiao efetiva" OK "$REGION"
else
  row K2 "regiao efetiva" FALHA "AWS_DEFAULT_REGION vazio"
fi

echo "${C}conta: $ACCOUNT   regiao: ${REGION:-?}${N}"
echo

# ---------- limpeza --------------------------------------------------------
BUCKET="bcc-cloud-teste-${ACCOUNT}-$(date +%s)"
KP_NAME="kp-teste-bcc-cloud-$(date +%s)"
CREATED_BUCKET=0
CREATED_KP=0
cleanup() {
  if [ "$CREATED_BUCKET" -eq 1 ]; then
    aws s3 rb "s3://$BUCKET" --force >/dev/null 2>&1 && \
      echo "${C}limpeza: bucket $BUCKET removido${N}"
  fi
  if [ "$CREATED_KP" -eq 1 ]; then
    aws ec2 delete-key-pair --key-name "$KP_NAME" >/dev/null 2>&1 && \
      echo "${C}limpeza: key pair $KP_NAME removido${N}"
  fi
}
trap cleanup EXIT

# ---------- K3: key pair (o item que pode bloquear o projeto) --------------
if out=$(aws ec2 create-key-pair --key-name "$KP_NAME" --key-type rsa \
          --query 'KeyName' --output text 2>&1); then
  CREATED_KP=1
  row K3 "criar key pair (CreateKeyPair)" OK "permitido"
else
  row K3 "criar key pair (CreateKeyPair)" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

TESTPUB="$(mktemp)"
if [ -f "$HOME/.ssh/id_ed25519.pub" ]; then
  cat "$HOME/.ssh/id_ed25519.pub" > "$TESTPUB"
else
  # gera um par efêmero só para o teste de importação e descarta a privada
  ssh-keygen -q -t ed25519 -N '' -f "${TESTPUB}.key" >/dev/null 2>&1
  cat "${TESTPUB}.key.pub" > "$TESTPUB"
  rm -f "${TESTPUB}.key" "${TESTPUB}.key.pub"
fi
if out=$(aws ec2 import-key-pair --key-name "${KP_NAME}-imp" \
          --public-key-material "fileb://$TESTPUB" --query 'KeyName' --output text 2>&1); then
  row K3b "importar key pair (ImportKeyPair)" OK "permitido"
  aws ec2 delete-key-pair --key-name "${KP_NAME}-imp" >/dev/null 2>&1
else
  row K3b "importar key pair (ImportKeyPair)" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi
rm -f "$TESTPUB"

# ---------- K6/K7: IAM pré-existente --------------------------------------
if out=$(aws iam get-role --role-name LabRole --query 'Role.Arn' --output text 2>&1); then
  row K6 "LabRole existe" OK "$(echo "$out" | tail -n1)"
else
  row K6 "LabRole existe" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

if out=$(aws iam get-instance-profile --instance-profile-name LabInstanceProfile \
          --query 'InstanceProfile.InstanceProfileName' --output text 2>&1); then
  row K7 "LabInstanceProfile existe" OK "nome exato confirmado"
else
  row K7 "LabInstanceProfile existe" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

# ---------- K10: ECR ------------------------------------------------------
if out=$(aws ecr get-login-password --region "${REGION:-us-east-1}" 2>&1); then
  row K10 "ECR liberado (get-login-password)" OK "token obtido (nao exibido)"
else
  row K10 "ECR liberado (get-login-password)" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

# ---------- K11: S3 (cria e remove) ---------------------------------------
if [ "${REGION:-us-east-1}" = "us-east-1" ]; then
  if out=$(aws s3api create-bucket --bucket "$BUCKET" --region us-east-1 2>&1); then
    CREATED_BUCKET=1
  fi
else
  if out=$(aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
            --create-bucket-configuration LocationConstraint="$REGION" 2>&1); then
    CREATED_BUCKET=1
  fi
fi

if [ "$CREATED_BUCKET" -eq 1 ]; then
  if aws s3api put-bucket-versioning --bucket "$BUCKET" \
       --versioning-configuration Status=Enabled >/dev/null 2>&1; then
    row K11 "S3: criar + versionar bucket" OK "ok (removido no fim)"
  else
    row K11 "S3: criar + versionar bucket" INCONCLUSIVO "criou, versionamento negado"
  fi
else
  row K11 "S3: criar + versionar bucket" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

# ---------- K14: RDS ------------------------------------------------------
if out=$(aws rds describe-db-subnet-groups --query 'DBSubnetGroups[].DBSubnetGroupName' --output text 2>&1); then
  if [ -z "$(echo "$out" | tr -d '[:space:]')" ]; then
    row K14 "RDS: DB subnet group disponivel" INCONCLUSIVO "nenhum subnet group (Opcao 2 fica em risco)"
  else
    row K14 "RDS: DB subnet group disponivel" OK "$(echo "$out" | tr '\n' ' ' | cut -c1-60)"
  fi
else
  row K14 "RDS: DB subnet group disponivel" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

# ---------- K4: tipos de instância ---------------------------------------
if out=$(aws ec2 describe-instance-type-offerings --location-type region \
          --filters "Name=location,Values=${REGION:-us-east-1}" \
          --query 'InstanceTypeOfferings[].InstanceType' --output text 2>&1); then
  HAS_SMALL=nao; HAS_MICRO=nao
  echo "$out" | tr '\t' '\n' | grep -qx 't3.small' && HAS_SMALL=sim
  echo "$out" | tr '\t' '\n' | grep -qx 't3.micro' && HAS_MICRO=sim
  row K4 "tipos de instancia na regiao" OK "t3.small=$HAS_SMALL t3.micro=$HAS_MICRO"
else
  row K4 "tipos de instancia na regiao" FALHA "$(echo "$out" | head -n1 | cut -c1-90)"
fi

# ---------- K5: cota de vCPU ---------------------------------------------
if out=$(aws service-quotas get-service-quota --service-code ec2 \
          --quota-code L-1216C47A --query 'Quota.Value' --output text 2>&1); then
  row K5 "cota de vCPU on-demand" OK "valor=$(printf '%.0f' "$out" 2>/dev/null || echo "$out")"
else
  row K5 "cota de vCPU on-demand" INCONCLUSIVO "service-quotas negado"
fi

# ---------- K9: OIDC (opcional, write em IAM) ----------------------------
if [ "$COM_IAM" -eq 1 ]; then
  if out=$(aws iam create-open-id-connect-provider \
            --url https://token.actions.githubusercontent.com \
            --client-id-list sts.amazonaws.com \
            --query 'OpenIDConnectProviderArn' --output text 2>&1); then
    row K9 "OIDC provider para GitHub Actions" N/A "PERMITIDO (inesperado) - removendo"
    aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$out" >/dev/null 2>&1
  else
    row K9 "OIDC provider para GitHub Actions" OK "bloqueado (esperado) - use secrets temporarios"
  fi
else
  row K9 "OIDC provider para GitHub Actions" N/A "nao testado (rode com --com-iam)"
fi

# ---------- registro -----------------------------------------------------
echo
if [ "$FAIL" -eq 0 ]; then
  printf '%sTodos os itens obrigatorios passaram.%s\n' "$G" "$N"
else
  printf '%s%d item(ns) FALHARAM — leia os detalhes acima antes de continuar.%s\n' "$R" "$FAIL" "$N"
fi

mkdir -p "$EVID"
{
  echo
  echo "## Execução $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo
  echo "- conta: \`$ACCOUNT\`  região: \`${REGION:-?}\`  ARN: \`$ARN\`"
  echo
  echo "| # | data | verificação | estado | detalhe |"
  echo "| --- | --- | --- | --- | --- |"
  printf '%s\n' "${ROWS[@]}"
} >> "$LOG_MD"
echo
echo "Registro anexado em: docs/evidencias/sandbox.md"
echo
echo "Próximo passo: docs/03-guia-pre-requisitos.md §4 (chave SSH) e §6 (git init)."

exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
