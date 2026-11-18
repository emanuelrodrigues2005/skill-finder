#!/usr/bin/env bash
# restart-clean.sh — derruba o stack, garante as portas livres e sobe de novo.
#
# Por que down antes de up: quando o container da API morre de forma anormal, o
# Docker Desktop mantem um proxy na 8080 apontando para o container que nao
# existe mais, e o `up` seguinte falha com "address already in use". O `down`
# remove o container e o proxy junto; o volume do Postgres sobrevive.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

porta_livre() {
  ! ss -tlnH "sport = :$1" 2>/dev/null | grep -q .
}

echo "== 1. derrubando (volume preservado) =="
docker compose --profile dev --profile prod down --remove-orphans 2>&1 | tail -6

echo
echo "== 2. portas =="
for p in 8080 8081; do
  for _ in $(seq 1 20); do
    porta_livre "$p" && break
    sleep 1
  done
  if porta_livre "$p"; then echo "  $p livre"; else echo "  $p AINDA OCUPADA"; ss -tlnH "sport = :$p" | sed 's/^/      /'; fi
done

echo
echo "== 3. subindo =="
timeout 900 make up 2>&1 | tail -8
echo "UP_EXIT=$?"

echo
echo "== 4. migrate + seed =="
timeout 300 make migrate 2>&1 | tail -3
timeout 300 make seed 2>&1 | tail -3

echo
echo "== 5. containers =="
docker compose --profile dev ps --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'

echo
echo "== 6. HTTP =="
for url in http://127.0.0.1:8080/healthz http://127.0.0.1:8080/readyz http://127.0.0.1:8081/ http://127.0.0.1:8081/api/v1/skills; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
  printf '  %-44s HTTP %s\n' "$url" "$code"
done
