#!/usr/bin/env bash
# =============================================================================
# setup-node-wsl.sh — instala Node 22 + pnpm (via corepack) DENTRO do WSL/Ubuntu
#
# Por que existe: o `pnpm` que apareceu no PATH do Ubuntu era o shim do Windows
# (/mnt/c/.../corepack-shims/pnpm), que tenta executar um `node` que não existe
# no Linux. Resultado: `pnpm: exec: node: not found`. Este script instala o Node
# nativo no Ubuntu e ativa o pnpm pelo corepack que vem com ele.
#
# Uso, dentro do Ubuntu:
#   bash scripts/setup-node-wsl.sh
#   bash scripts/setup-node-wsl.sh --check     # só diagnostica, não instala
#
# Requer sudo (apt). É idempotente: se já houver Node 22 nativo, não reinstala.
# =============================================================================
set -euo pipefail

CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
info() { printf '%s..%s %s\n' "$C" "$N" "$*"; }
ok()   { printf '%sOK%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s  %s\n' "$Y" "$N" "$*"; }
die()  { printf '%sFALHA%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# Um binário resolvido em /mnt/... é do Windows e não serve para rodar o projeto
# no Linux: ele depende de um node.exe do outro lado.
is_windows_path() {
  case "$1" in
    /mnt/*) return 0 ;;
    *) return 1 ;;
  esac
}

describe() { # nome-do-binario
  local b="$1" p
  p="$(command -v "$b" 2>/dev/null || true)"
  if [ -z "$p" ]; then echo "ausente"; else echo "$p"; fi
}

echo "=== diagnóstico ==="
NODE_PATH_FOUND="$(describe node)"
PNPM_PATH_FOUND="$(describe pnpm)"
printf '  node  -> %s\n  pnpm  -> %s\n' "$NODE_PATH_FOUND" "$PNPM_PATH_FOUND"
printf '  arch  -> %s | distro -> %s\n' "$(uname -m)" "$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-?}")"

NEED_INSTALL=0
if [ "$NODE_PATH_FOUND" = "ausente" ]; then
  NEED_INSTALL=1
  warn "não há 'node' no PATH do Ubuntu"
elif is_windows_path "$NODE_PATH_FOUND"; then
  NEED_INSTALL=1
  warn "'node' resolveu para um caminho do Windows — não serve para rodar o backend no Linux"
else
  NODE_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    NEED_INSTALL=1
    warn "Node $(node -v) é anterior ao 22 (o projeto usa Node 22)"
  else
    ok "Node nativo $(node -v)"
  fi
fi

if [ "$PNPM_PATH_FOUND" != "ausente" ] && is_windows_path "$PNPM_PATH_FOUND"; then
  warn "o 'pnpm' atual é o shim do Windows — será substituído pelo pnpm nativo do Ubuntu"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  [ "$NEED_INSTALL" -eq 0 ] && ok "ambiente pronto; nada a fazer" || warn "rode sem --check para instalar"
  exit 0
fi

# ---------- instalação do Node 22 (NodeSource) -----------------------------
if [ "$NEED_INSTALL" -eq 1 ]; then
  if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
    command -v sudo >/dev/null 2>&1 || die "precisa de sudo (ou rodar como root)"
    echo "Este passo usa sudo para instalar o Node via apt."
    sudo -v
    SUDO="sudo"
  fi

  info "instalando pré-requisitos..."
  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends ca-certificates curl gnupg

  info "configurando o repositório NodeSource para Node 22..."
  $SUDO install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y nodejs

  hash -r 2>/dev/null || true
  ok "Node instalado: $(node -v)"
fi

# ---------- pnpm pelo corepack --------------------------------------------
# O corepack vem com o Node 22. `corepack enable` escreve os shims no diretório
# bin do Node (/usr/bin), que vem ANTES de /mnt/c no PATH.
info "ativando o pnpm pelo corepack (versão fixada no package.json: pnpm@9.15.4)..."
if [ "$(id -u)" -eq 0 ]; then SUDO2=""; else SUDO2="sudo"; fi
$SUDO2 corepack enable
$SUDO2 corepack prepare pnpm@9.15.4 --activate
hash -r 2>/dev/null || true

PNPM_AFTER="$(describe pnpm)"
if [ "$PNPM_AFTER" = "ausente" ] || is_windows_path "$PNPM_AFTER"; then
  warn "o pnpm do Linux não assumiu o PATH (resolveu para: ${PNPM_AFTER:-vazio})"
  echo "      Rode: hash -r ; rehash   (ou abra um terminal novo) e confira 'command -v pnpm'."
  echo "      Se persistir, o PATH do Windows está à frente: use 'corepack pnpm' ou ajuste o PATH."
  exit 1
fi

# ---------- verificação final ---------------------------------------------
echo
echo "======================= VERIFICACAO ======================="
ok "node   -> $(node -v)  ($(command -v node))"
ok "pnpm   -> $(pnpm -v)  ($(command -v pnpm))"
printf '  npm    -> %s\n' "$(npm -v 2>/dev/null || echo 'ausente')"
echo "=========================================================="
echo
echo "Próximo passo:"
echo "  make bootstrap        # gera e fixa o pnpm-lock.yaml (precisa de rede)"
echo "  make up               # sobe postgres + api + web"
