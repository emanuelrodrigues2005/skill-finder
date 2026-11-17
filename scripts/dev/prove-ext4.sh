#!/usr/bin/env bash
# prove-ext4.sh — prova que a lentidao e o 9p, rodando a MESMA suite numa copia
# em ext4 (home do WSL) em vez de /mnt/c.
#
# Nao mexe no checkout: copia backend/ (sem node_modules/dist) para ~/cloud-ext4,
# instala as dependencias UMA vez e mede. Se a copia em ext4 for ordens de
# grandeza mais rapida, o problema esta provado e o fix e rodar a verificacao la.
set -uo pipefail
SRC=/mnt/c/Users/Lima02/Documents/bcc/cloud/backend
DST=$HOME/cloud-ext4/backend
OUT=$HOME/cloud-ext4/prove.log
mkdir -p "$HOME/cloud-ext4"
: > "$OUT"

echo "=== copiando fonte (sem node_modules/dist) ===" | tee -a "$OUT"
rsync -a --delete --exclude node_modules --exclude dist --exclude coverage \
  "$SRC/" "$DST/" 2>&1 | tail -2 | tee -a "$OUT"

cd "$DST"

if [ ! -d node_modules ]; then
  echo "=== instalando dependencias em ext4 (uma vez) ===" | tee -a "$OUT"
  /usr/bin/time -f 'install: %es' pnpm install --frozen-lockfile >>"$OUT" 2>&1 \
    || { echo "install falhou"; tail -20 "$OUT"; exit 1; }
fi

echo "=== medindo --listTests em ext4 ===" | tee -a "$OUT"
/usr/bin/time -f 'listTests ext4: %es (user %Us / sys %Ss)' \
  node_modules/.bin/jest --listTests >>"$OUT" 2>&1

echo "=== medindo cors.spec.ts em ext4 ===" | tee -a "$OUT"
/usr/bin/time -f 'cors ext4: %es (user %Us / sys %Ss)' \
  node_modules/.bin/jest test/cors.spec.ts --silent >>"$OUT" 2>&1

echo
tail -14 "$OUT"
