#!/usr/bin/env bash
# offline-check.sh — prova, e não declara, que unit + api passam **sem rede**.
#
# Por que namespace de rede e não `nock.disableNetConnect()`: o nock intercepta
# `http(s)`, então ele nunca poderia provar nada sobre o `skills.sh` acessado por
# outro caminho nem sobre o `pg` (que abre `net.Socket` cru). Um namespace de
# rede novo, sem rota, tira a rede do processo — se a suíte ainda passar ali, ela
# não depende de internet. `unshare -rn` (user + net) funciona neste WSL; o #29
# mediu.
#
# A cadeia, na ordem — cada passo pode reprovar o anterior:
#   1. preflight: `unshare -rn` funciona? Senão exit 2, com instrução. Nunca
#      degradar em silêncio (rodar a suíte com rede e chamar de offline seria o
#      pior resultado possível).
#   2. canário (`assert-no-network.mjs`): dentro do netns, as duas sondas têm de
#      falhar. Se qualquer uma alcançar a rede, exit 3: a prova não vale.
#   3. `ip link set lo up`: o Supertest sobe a app em 127.0.0.1 e precisa do
#      loopback. É a única interface que sobe; não há rota para fora.
#   4. jest unit e api, com `--json` para ler as contagens.
#   5. anti-skip: `numPendingTests`/`numTodoTests` > 0 ou suíte vazia = exit 4.
#      Um teste pulado "porque não há rede" transformaria o gate em fachada.
#
# Uso: `make offline-check` (ou `bash backend/test/offline/offline-check.sh`).
set -uo pipefail

# O script mora em backend/test/offline; o cwd dos comandos é backend/.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "ERRO: backend/ nao encontrado a partir de ${BASH_SOURCE[0]}" >&2; exit 2; }

EXIT_NO_NETNS=2
EXIT_CANARY=3
EXIT_SKIP=4
EXIT_TESTS=5

echo "=== offline-check (${ROOT}) ==="

# 1. Preflight do mecanismo. Sem ele o alvo falha — não vira "passou offline".
if ! unshare -rn true >/dev/null 2>&1; then
  cat >&2 <<'MSG'
ERRO: `unshare -rn` nao funciona nesta maquina, entao o offline NAO pode ser provado.
      Este alvo nao degrada em silencio: sem namespace de rede nao existe prova.
      Requisitos: kernel Linux com user namespaces habilitados. WSL2 (Ubuntu)
      atende (medido na #29); container com seccomp/AppArmor restritivo pode nao.
      Confira com: unshare -rn ip link show lo
MSG
  exit "$EXIT_NO_NETNS"
fi
echo "preflight: unshare -rn ok"

OUT="$(mktemp -d)"
cleanup() { rm -rf "$OUT"; }
trap cleanup EXIT INT TERM

# Todo o resto roda dentro do netns. `bash -s -- "$OUT"`: script pelo stdin,
# diretório dos relatórios JSON no $1 (mesmo /tmp, cria-se antes do namespace).
unshare -rn bash -s -- "$OUT" <<'NETNS'
set -uo pipefail

OUT="$1"

echo ""
echo "=== 1/5 canario: a rede esta mesmo fora? ==="
if ! node test/offline/assert-no-network.mjs; then
  echo "" >&2
  echo "FALHA: o canario alcancou a rede. A prova nao vale; a suite NAO sera executada." >&2
  exit 3
fi

echo ""
echo "=== 2/5 loopback (unica interface; sem rota para fora) ==="
ip link set lo up || {
  echo "FALHA: nao foi possivel levantar lo; o Supertest precisa dele." >&2
  exit 2
}
ip -br addr show lo

check_json() {
  # $1 = arquivo JSON do jest, $2 = rotulo do nivel
  if [ ! -f "$1" ]; then
    echo "FALHA: o jest nao gerou o relatorio de $2 ($1); veja a saida acima." >&2
    return 4
  fi
  JSON_FILE="$1" LABEL="$2" node -e '
    const fs = require("node:fs");
    const results = JSON.parse(fs.readFileSync(process.env.JSON_FILE, "utf8"));
    const total = results.numTotalTests ?? 0;
    const failed = results.numFailedTests ?? 0;
    const skipped = (results.numPendingTests ?? 0) + (results.numTodoTests ?? 0);
    console.log(`${process.env.LABEL}: ${total} testes | ${failed} falhas | ${skipped} pulados`);
    if (total === 0) {
      console.error(`FALHA: ${process.env.LABEL} rodou 0 testes; suite vazia nao prova nada.`);
      process.exit(4);
    }
    if (skipped > 0) {
      console.error(`FALHA: ${process.env.LABEL} tem ${skipped} teste(s) pulado(s); o offline-check nao aceita skip.`);
      process.exit(4);
    }
  '
}

# `>/dev/null` no jest: com `--json` o stdout e o JSON e o resumo humano vai para
# stderr, que continua visivel. Sem `--`: o pnpm repassa os argumentos ao script
# (com `--`, o `--json` chega ao jest como padrao de caminho e a suite nao roda).
echo ""
echo "=== 3/5 unit (jest, dentro do netns) ==="
pnpm test --json --outputFile "$OUT/unit.json" >/dev/null
unit=$?
check_json "$OUT/unit.json" "unit"; skip=$?
if [ "$unit" -ne 0 ]; then
  echo "FALHA: a suite unitaria falhou dentro do netns (exit $unit)." >&2
  exit 5
fi
if [ "$skip" -ne 0 ]; then
  exit "$skip"
fi

echo ""
echo "=== 4/5 api / e2e (jest, dentro do netns) ==="
pnpm test:e2e --json --outputFile "$OUT/api.json" >/dev/null
api=$?
check_json "$OUT/api.json" "api"; skip=$?
if [ "$api" -ne 0 ]; then
  echo "FALHA: a suite de api falhou dentro do netns (exit $api)." >&2
  exit 5
fi
if [ "$skip" -ne 0 ]; then
  exit "$skip"
fi

echo ""
echo "=== 5/5 ok: sem rede, sem skip, unit + api verdes ==="
exit 0
NETNS
status=$?

echo ""
if [ "$status" -eq 0 ]; then
  echo "offline-check OK: canario bloqueado, loopback de pe, unit + api verdes, nenhum teste pulado."
  exit 0
fi

case "$status" in
  "$EXIT_NO_NETNS") echo "offline-check FALHOU: sem netns nao ha prova (exit $status)." >&2 ;;
  "$EXIT_CANARY") echo "offline-check FALHOU: o canario alcancou a rede (exit $status)." >&2 ;;
  "$EXIT_SKIP") echo "offline-check FALHOU: teste pulado ou suite vazia (exit $status)." >&2 ;;
  "$EXIT_TESTS") echo "offline-check FALHOU: a suite quebrou dentro do netns (exit $status)." >&2 ;;
  *) echo "offline-check FALHOU (exit $status)." >&2 ;;
esac
exit "$status"
