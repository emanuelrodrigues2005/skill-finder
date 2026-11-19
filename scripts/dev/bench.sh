#!/usr/bin/env bash
# bench.sh — diagnostico de lentidao do Jest no /mnt/c (9p) e no filesystem Linux.
#
# Mede onde o Jest escreve cache, quantos arquivos o node_modules tem e quanto
# custa uma execucao curta nos dois cenarios. Existe porque as sessoes de agente
# estavam gastando ~15 min por rodada de verificacao.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT/backend"
OUT="$ROOT/.logs/bench.log"
mkdir -p "$(dirname "$OUT")"
: > "$OUT"

{
  echo "=== filesystem do checkout ==="
  df -hT . | tail -1
  echo
  echo "=== node_modules ==="
  echo "arquivos: $(find node_modules -type f 2>/dev/null | wc -l)"
  echo "tamanho : $(du -sh node_modules 2>/dev/null | cut -f1)"
  echo
  echo "=== cache do Jest (config atual) ==="
  node_modules/.bin/jest --showConfig 2>/dev/null | grep -E '"(cacheDirectory|maxWorkers|rootDir)"' | head -5
  echo
  echo "=== caches existentes em /tmp ==="
  ls -d /tmp/jest* 2>/dev/null | head -5
  du -sh /tmp/jest* 2>/dev/null | head -5
  echo
  echo "=== medindo: jest --listTests (sem compilar) ==="
  /usr/bin/time -f 'listTests: %es  (user %Us / sys %Ss)' \
    node_modules/.bin/jest --listTests >/dev/null 2>>"$OUT"
  echo
  echo "=== medindo: uma suite unitaria pequena (cors) com cache default ==="
  /usr/bin/time -f 'cors default: %es (user %Us / sys %Ss)' \
    node_modules/.bin/jest test/cors.spec.ts --silent >/dev/null 2>>"$OUT"
  echo
  echo "=== medindo: mesma suite com cache em /tmp e 2 workers ==="
  /usr/bin/time -f 'cors /tmp+2w: %es (user %Us / sys %Ss)' \
    node_modules/.bin/jest test/cors.spec.ts --silent --cacheDirectory=/tmp/jest-bench -w 2 >/dev/null 2>>"$OUT"
} 2>&1 | tee -a "$OUT"

echo
echo "log: $OUT"
