#!/usr/bin/env bash
# db-test-diag.sh — o que o Postgres de teste realmente tem (usuario, senha, banco).
set -uo pipefail

echo "== env do container =="
docker inspect skills-db-test --format '{{range .Config.Env}}{{println .}}{{end}}' 2>&1 \
  | grep -E '^POSTGRES_' | sed 's/^/  /'

echo
echo "== roles e bancos =="
docker exec skills-db-test psql -U skills -d skills_test -tAc \
  "select rolname from pg_roles where rolname in ('skills','postgres') order by 1" 2>&1 | sed 's/^/  role: /'
docker exec skills-db-test psql -U skills -d skills_test -tAc \
  "select datname from pg_database where datname like 'skills%' order by 1" 2>&1 | sed 's/^/  db:   /'

echo
echo "== tabelas aplicadas =="
docker exec skills-db-test psql -U skills -d skills_test -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>&1 | sed 's/^/  tabelas: /'

echo
echo "== senha funciona por TCP (nao socket)? =="
docker run --rm --network host -e PGPASSWORD=skills postgres:16-alpine \
  psql -h 127.0.0.1 -p 55432 -U skills -d skills_test -tAc 'select 1' 2>&1 | sed 's/^/  tcp: /'
