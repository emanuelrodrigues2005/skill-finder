#!/usr/bin/env bash
# =============================================================================
# bootstrap-state.sh — cria o bucket S3 do estado do Terraform (uma vez)
#
# Por que isso existe: `terraform init` com backend S3 falha se o bucket ainda
# não existe. E o bucket NÃO pode ser criado pelo state que vai morar nele, então
# ele é um passo de bootstrap fora do Terraform (docs/02 §7.3, docs/03 §7).
#
# Uso, dentro do Ubuntu, na raiz do repositório:
#   source ~/.local/bin/academy-env
#   bash scripts/bootstrap-state.sh                 # sufixo = id da conta AWS
#   bash scripts/bootstrap-state.sh --suffix rpe    # sufixo explícito
#   bash scripts/bootstrap-state.sh --dry-run       # só mostra o que faria
#
# É idempotente: rodar de novo não recria nem apaga nada.
# =============================================================================
set -euo pipefail

SUFFIX=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --suffix) SUFFIX="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1 (use --help)" >&2; exit 2 ;;
  esac
done

C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
info() { printf '%s..%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%sOK%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s  %s\n' "$Y" "$N" "$*"; }
die()  { printf '%sFALHA%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# ---------- pré-condições --------------------------------------------------
[ -n "${AWS_SESSION_TOKEN:-}" ] || die "AWS_SESSION_TOKEN vazio. Rode: source ~/.local/bin/academy-env"
command -v aws >/dev/null 2>&1 || die "aws CLI não encontrada no PATH"

REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "credenciais inválidas ou expiradas (aws sts get-caller-identity falhou)"

if [ -z "$SUFFIX" ]; then
  SUFFIX="$ACCOUNT"
fi
BUCKET="bcc-cloud-tfstate-${SUFFIX}"

info "conta:   $ACCOUNT"
info "região:  $REGION"
info "bucket:  $BUCKET"

# nome de bucket S3: 3-63 chars, minúsculas, dígitos, hífen e ponto
if ! printf '%s' "$BUCKET" | grep -Eq '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'; then
  die "nome de bucket inválido: '$BUCKET' (use só minúsculas, números, '-' e '.')"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  warn "dry-run: nada será criado"
  exit 0
fi

# ---------- 1. bucket -----------------------------------------------------
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  ok "bucket já existe — não recriado"
else
  info "criando bucket..."
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region us-east-1 >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  fi
  ok "bucket criado"
fi

# ---------- 2. versionamento ----------------------------------------------
# obrigatório: o state é sobrescrito a cada apply; o versionamento é o único
# jeito de voltar a uma versão anterior se o state for corrompido.
info "habilitando versionamento..."
aws s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled >/dev/null
V="$(aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text)"
[ "$V" = "Enabled" ] && ok "versionamento: Enabled" || die "versionamento não ficou Enabled (retornou '$V')"

# ---------- 3. criptografia -----------------------------------------------
info "habilitando criptografia SSE-S3..."
aws s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null
ok "criptografia SSE-S3 aplicada"

# ---------- 4. bloqueio de acesso público ---------------------------------
info "bloqueando acesso público..."
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
ok "acesso público bloqueado"

# ---------- 5. o que fazer com o nome -------------------------------------
echo
echo "=============================================================="
echo "Bucket pronto. Cole este bloco em infra/backend.tf:"
echo "=============================================================="
cat <<HCL
terraform {
  backend "s3" {
    bucket       = "${BUCKET}"
    key          = "projeto2/terraform.tfstate"
    region       = "${REGION}"
    encrypt      = true
    use_lockfile = true   # Terraform >= 1.10; senão use DynamoDB (docs/02 §7.3)
  }
}
HCL
echo "=============================================================="
echo
warn "NÃO apague este bucket: é o registro do que o Terraform criou."
warn "Para atualizar a variável do seu ambiente nesta sessão:"
echo "      export TF_STATE_BUCKET='${BUCKET}'"
echo "      # e edite a linha TF_STATE_BUCKET em ~/.local/bin/academy-env"
