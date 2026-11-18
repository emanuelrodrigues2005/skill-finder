#!/usr/bin/env bash
# db-test-status.sh — estado do Postgres de teste (porta 55432).
set -uo pipefail
echo "== container =="
docker ps -a --filter name=skills-db-test --format '  {{.Names}}  {{.Status}}' || true
echo "== porta 55432 =="
if (exec 3<>/dev/tcp/127.0.0.1/55432) 2>/dev/null; then
  echo "  aceita conexao TCP"
  exec 3<&- 3>&-
else
  echo "  nao aceita conexao"
fi
echo "== banco responde? =="
docker exec skills-db-test pg_isready -U skills -d skills_test 2>&1 | sed 's/^/  /' || echo "  exec falhou"
