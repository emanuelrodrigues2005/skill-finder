#!/usr/bin/env bash
# prisma-runtime-check.sh — prova que o comando de migrate que o runbook manda
# rodar no container `api` funciona na imagem `runtime`: uid 10001, /app somente
# leitura, nenhuma rede no container e nenhum `pnpm install` na imagem.
#
# O comando sai do próprio runbook (`docs/runbook-operacao.md`), não daqui: é ele
# que a F4 vai copiar e que a próxima pessoa vai digitar. Se o runbook divergir
# da imagem, isto falha.
#
# Uso: bash scripts/dev/prisma-runtime-check.sh
# Requer: docker com o daemon de pé e rede no host (o build roda `pnpm install`).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNBOOK="$ROOT/docs/runbook-operacao.md"
IMAGE="${IMAGE:-skill-finder-api:prisma-runtime-check}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_NAME="prisma-runtime-check-pg-$$"
PG_USER="skills"
PG_PASSWORD="check"
PG_DB="skills"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:5432/${PG_DB}?schema=public"
FAILS=0

cleanup() { docker rm -f "$PG_NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { echo "FALHA: $*"; FAILS=$((FAILS + 1)); }
show() { echo "--- saida ---"; printf '%s\n' "$1"; echo "-------------"; }

echo "== 1. comando de migrate documentado no runbook =="
mapfile -t DOCUMENTED < <(grep -oE "exec -T api [^']+" "$RUNBOOK" | sed 's/^exec -T api //' | sed 's/[[:space:]]*$//' | sort -u)
if [ "${#DOCUMENTED[@]}" -ne 1 ]; then
  echo "o runbook tem ${#DOCUMENTED[@]} comandos distintos para 'exec -T api':"
  printf '  %s\n' "${DOCUMENTED[@]}"
  echo "FALHA: o runbook precisa de um único comando de migrate, em §1.6 e §2.2"
  exit 1
fi
read -ra MIGRATE <<< "${DOCUMENTED[0]}"
printf 'comando: %s\n' "${MIGRATE[*]}"

echo
echo "== 2. build do alvo runtime =="
if ! docker build --target runtime -t "$IMAGE" "$ROOT/backend"; then
  echo "FALHA: build da imagem runtime"
  exit 1
fi

echo
echo "== 3. postgres descartável sem rede: $PG_NAME =="
docker rm -f "$PG_NAME" >/dev/null 2>&1
if ! docker run -d --name "$PG_NAME" --network none \
  -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
  "$PG_IMAGE" >/dev/null; then
  echo "FALHA: subir o postgres descartável"
  exit 1
fi
ready=0
for _ in $(seq 1 60); do
  docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && { ready=1; break; }
  sleep 1
done
if [ "$ready" != 1 ]; then
  docker logs "$PG_NAME" 2>&1 | tail -20
  echo "FALHA: postgres não ficou pronto em 60s"
  exit 1
fi
echo "postgres pronto (só loopback: a api entra pela rede dele e fica sem saída)"

echo
echo "== 4. primeira execução do migrate =="
out="$(timeout 240 docker run --rm --network "container:$PG_NAME" \
  -e DATABASE_URL="$DATABASE_URL" "$IMAGE" "${MIGRATE[@]}" 2>&1)"; status=$?
show "$out"
echo "exit=$status"
if [ "$status" = 0 ]; then
  echo
  echo "== 5. segunda execução (idempotente) =="
  out="$(timeout 240 docker run --rm --network "container:$PG_NAME" \
    -e DATABASE_URL="$DATABASE_URL" "$IMAGE" "${MIGRATE[@]}" 2>&1)"; status=$?
  show "$out"
  echo "exit=$status"
  [ "$status" = 0 ] || fail "segunda execução falhou (exit $status)"
  printf '%s\n' "$out" | grep -q 'No pending migrations to apply.' \
    || fail "segunda execução não respondeu 'No pending migrations to apply.'"
else
  fail "migrate falhou na imagem runtime (exit $status); a segunda execução não foi tentada"
fi

echo
if [ "$FAILS" != 0 ]; then
  echo "RESULTADO: FALHAS=$FAILS"
  exit 1
fi
echo "RESULTADO: FALHAS=0 — '${MIGRATE[*]}' roda na imagem runtime como 10001, sem install e sem rede"
