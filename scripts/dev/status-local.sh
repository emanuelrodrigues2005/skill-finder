#!/usr/bin/env bash
# status-local.sh — estado do stack que está rodando agora.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

echo "== containers (profile dev) =="
docker compose --profile dev ps --format '{{.Name}}\t{{.Status}}\t{{.Ports}}' 2>&1 | sed 's/^/  /'

echo
echo "== endpoints =="
for url in \
  "http://127.0.0.1:8080/healthz" \
  "http://127.0.0.1:8080/readyz" \
  "http://127.0.0.1:8080/metrics" \
  "http://127.0.0.1:8080/api/v1/categories" \
  "http://127.0.0.1:8081/" \
  "http://127.0.0.1:8081/api/v1/categories"
do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo 000)"
  printf '  %-46s HTTP %s\n' "$url" "$code"
done

echo
echo "== /healthz corpo =="
curl -sS --max-time 5 http://127.0.0.1:8080/healthz 2>&1 | sed 's/^/  /'
