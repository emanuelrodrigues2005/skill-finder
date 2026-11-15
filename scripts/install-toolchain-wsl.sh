#!/usr/bin/env bash
# =============================================================================
# install-toolchain-wsl.sh — AWS CLI v2 + Terraform (>= 1.10) no WSL/Ubuntu
#
# Uso, dentro do Ubuntu:
#   bash scripts/install-toolchain-wsl.sh
#   bash scripts/install-toolchain-wsl.sh --with-ansible   # opcional
#
# O que faz:
#   1. instala os pré-requisitos de sistema (curl, unzip, gnupg, lsb-release...)
#   2. instala o AWS CLI v2 pelo instalador oficial (zip)
#   3. instala o Terraform pelo repositório apt oficial da HashiCorp
#   4. verifica versões e FALHA (exit 1) se o Terraform ficar < 1.10
#
# Requer sudo. É seguro rodar de novo: reinstala/atualiza, não duplica.
# Este script NÃO instala Docker (use o Docker Desktop com integração WSL, ou
# `docs/03-guia-pre-requisitos.md` §3.7) e NÃO instala Ansible sem a flag.
# =============================================================================
set -euo pipefail

WITH_ANSIBLE=0
for arg in "$@"; do
  case "$arg" in
    --with-ansible) WITH_ANSIBLE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg (use --help)" >&2; exit 2 ;;
  esac
done

# --- helpers ---------------------------------------------------------------
c_ok()   { printf '\033[32mOK\033[0m   %s\n' "$*"; }
c_info() { printf '\033[36m..\033[0m   %s\n' "$*"; }
c_warn() { printf '\033[33mAVISO\033[0m %s\n' "$*"; }
c_err()  { printf '\033[31mFALHA\033[0m %s\n' "$*" >&2; }

# true se $1 >= $2 (comparação de versão semver, via sort -V)
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    c_err "precisa de sudo (ou rodar como root)"; exit 1
  fi
  echo "Este script precisa de sudo para instalar pacotes. Pode pedir sua senha."
  sudo -v
  SUDO="sudo"
fi

# --- 0. contexto -----------------------------------------------------------
if [ -r /etc/os-release ]; then . /etc/os-release; else c_err "/etc/os-release ilegível"; exit 1; fi
ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64)  TF_ARCH="linux_amd64";  AWS_ZIP="awscli-exe-linux-x86_64.zip" ;;
  aarch64|arm64) TF_ARCH="linux_arm64";  AWS_ZIP="awscli-exe-linux-aarch64.zip" ;;
  *) c_err "arquitetura não suportada: $ARCH_RAW"; exit 1 ;;
esac
CODENAME="${VERSION_CODENAME:-}"
c_info "distro=${PRETTY_NAME:-?} codename=${CODENAME:-?} arch=${ARCH_RAW}"

# --- 1. pré-requisitos -----------------------------------------------------
c_info "atualizando índice do apt e instalando pré-requisitos..."
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends \
  ca-certificates curl unzip gnupg lsb-release jq make git

# --- 2. AWS CLI v2 ---------------------------------------------------------
c_info "instalando AWS CLI v2 (instalador oficial)..."
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT
curl -fsSL "https://awscli.amazonaws.com/${AWS_ZIP}" -o "$TMPD/awscliv2.zip"
unzip -q "$TMPD/awscliv2.zip" -d "$TMPD"
if command -v aws >/dev/null 2>&1; then
  $SUDO "$TMPD/aws/install" --update
else
  $SUDO "$TMPD/aws/install"
fi
hash -r 2>/dev/null || true
c_ok "AWS CLI: $(aws --version 2>&1)"

# --- 3. Terraform (apt oficial da HashiCorp) -------------------------------
c_info "configurando o repositório apt da HashiCorp..."
if [ -z "$CODENAME" ]; then
  c_err "não consegui descobrir o codename da distro; instale o Terraform manualmente (ver mensagem final)"
else
  $SUDO install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://apt.releases.hashicorp.com/gpg \
    | $SUDO gpg --dearmor --yes -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com ${CODENAME} main" \
    | $SUDO tee /etc/apt/sources.list.d/hashicorp.list >/dev/null
  if $SUDO apt-get update -y && $SUDO apt-get install -y terraform; then
    hash -r 2>/dev/null || true
    c_ok "Terraform instalado pelo apt da HashiCorp"
  else
    # Fallback: zip oficial (não depende do repositório ter o codename da sua distro)
    c_warn "o repositório apt da HashiCorp não aceitou '${CODENAME}'. Usando o zip oficial."
    TFVER="$(curl -fsSL https://checkpoint-api.hashicorp.com/v1/check/terraform \
             | sed -E 's/.*"current_version":"([0-9.]+)".*/\1/')"
    if [ -z "$TFVER" ]; then
      c_err "não consegui descobrir a versão atual do Terraform. Instale manualmente:"
      echo "        https://developer.hashicorp.com/terraform/install"
      exit 1
    fi
    c_info "baixando terraform ${TFVER} (${TF_ARCH})..."
    curl -fsSL -o "$TMPD/tf.zip" \
      "https://releases.hashicorp.com/terraform/${TFVER}/terraform_${TFVER}_${TF_ARCH}.zip"
    $SUDO unzip -o -q "$TMPD/tf.zip" -d /usr/local/bin
    $SUDO chmod 0755 /usr/local/bin/terraform
    hash -r 2>/dev/null || true
    c_ok "Terraform v${TFVER} instalado em /usr/local/bin"
  fi
fi

# --- 4. Ansible (opcional) -------------------------------------------------
if [ "$WITH_ANSIBLE" -eq 1 ]; then
  c_warn "instalando Ansible porque você passou --with-ansible (o projeto NÃO depende dele)"
  $SUDO apt-get install -y ansible
fi

# --- 5. verificação --------------------------------------------------------
echo
echo "======================= VERIFICAÇÃO ======================="
FAIL=0

if command -v aws >/dev/null 2>&1; then
  AWSV="$(aws --version 2>&1)"
  c_ok "aws            -> $AWSV"
  case "$AWSV" in aws-cli/1.*) c_err "AWS CLI v1 detectado; este guia assume v2"; FAIL=1 ;; esac
else
  c_err "aws não encontrado no PATH"; FAIL=1
fi

TFBIN="$(command -v terraform || true)"
if [ -n "$TFBIN" ]; then
  TFV="$(terraform version | head -n1 | sed -E 's/^Terraform v//')"
  if ver_ge "$TFV" "1.10"; then
    c_ok "terraform      -> v$TFV (>= 1.10: use_lockfile disponível)"
  else
    c_err "terraform      -> v$TFV (< 1.10). O backend S3 do guia usa use_lockfile."
    echo "        Corrija com o zip oficial:"
    echo "          curl -fsSL -o /tmp/tf.zip https://releases.hashicorp.com/terraform/<VERSAO>/terraform_<VERSAO>_${TF_ARCH}.zip"
    echo "          sudo unzip -o /tmp/tf.zip -d /usr/local/bin && sudo chmod +x /usr/local/bin/terraform"
    FAIL=1
  fi
else
  c_err "terraform não encontrado no PATH"; FAIL=1
fi

for t in jq git make; do
  if command -v "$t" >/dev/null 2>&1; then c_ok "$(printf '%-14s' "$t") -> $($t --version 2>&1 | head -n1)"; else c_err "$t ausente"; FAIL=1; fi
done

if command -v docker >/dev/null 2>&1; then
  c_ok "docker         -> $(docker compose version 2>&1 | head -n1)"
else
  c_warn "docker não encontrado neste Ubuntu. Use Docker Desktop com integração WSL (docs/03 §3.7)."
fi

if [ "$WITH_ANSIBLE" -eq 1 ]; then
  command -v ansible >/dev/null 2>&1 && c_ok "ansible        -> $(ansible --version | head -n1)" || c_warn "ansible ausente (opcional)"
fi

echo "=========================================================="
if [ "$FAIL" -ne 0 ]; then
  c_err "uma ou mais verificações falharam. Leia as linhas FALHA acima."
  exit 1
fi
c_ok "toolchain pronta."
echo
echo "Próximos passos:"
echo "  1. docs/03-guia-pre-requisitos.md §5  -> criar ~/.local/bin/academy-env (credenciais)"
echo "  2. docs/03-guia-pre-requisitos.md §2  -> Start Lab + aws sts get-caller-identity"
echo "  3. docs/03-guia-pre-requisitos.md §4  -> chave SSH (~/.ssh) e teste de conexão"
echo "  4. docs/03-guia-pre-requisitos.md §6  -> git init + .gitignore"
