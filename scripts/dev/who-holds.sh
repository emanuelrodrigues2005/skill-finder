#!/usr/bin/env bash
# who-holds.sh — descobre quem segura uma porta, por varios caminhos.
set -uo pipefail
PORTA="${1:-8080}"

echo "== ss =="
ss -tlnpH "sport = :$PORTA" 2>/dev/null | sed 's/^/  /' || echo "  (nada)"

echo "== lsof =="
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"$PORTA" -sTCP:LISTEN 2>/dev/null | sed 's/^/  /' || echo "  (nada)"
else
  echo "  lsof ausente"
fi

echo "== fuser =="
if command -v fuser >/dev/null 2>&1; then
  fuser -v "$PORTA"/tcp 2>&1 | sed 's/^/  /' || true
else
  echo "  fuser ausente"
fi

echo "== /proc (varredura) =="
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  if ls -l "$p/fd" 2>/dev/null | grep -q socket; then
    :
  fi
done
# caminho mais direto: comparar inodes de socket com os do ss
inode="$(ss -tlnH "sport = :$PORTA" 2>/dev/null | grep -oE 'ino:[0-9]+' | head -1 | cut -d: -f2)"
if [ -n "${inode:-}" ]; then
  echo "  inode do socket: $inode"
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    if ls -l "$p/fd" 2>/dev/null | grep -q "socket:\[$inode\]"; then
      echo "  pid=$pid cmd=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null | cut -c1-110)"
      echo "         cwd=$(readlink -f "$p/cwd" 2>/dev/null || echo '?')"
    fi
  done
else
  echo "  (sem inode)"
fi

echo "== containers que publicam a porta =="
docker ps -a --format '  {{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null | grep -F ":$PORTA->" || echo "  (nenhum)"
