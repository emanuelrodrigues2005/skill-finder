#!/usr/bin/env bash
# env-report.sh — estado do ambiente de execução local, sem depender de quoting.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== ferramentas =="
printf 'node    : %s\n' "$(node -v 2>&1)"
printf 'pnpm    : %s\n' "$(pnpm -v 2>&1)"
printf 'docker  : %s\n' "$(docker version --format '{{.Server.Version}}' 2>&1 | tail -1)"
printf 'compose : %s\n' "$(docker compose version --short 2>&1 | tail -1)"
printf 'make    : %s\n' "$(make --version 2>&1 | head -1)"

echo
echo "== arquivos de ambiente =="
for f in .env .env.example; do
  if [ -f "$f" ]; then printf '%-12s existe (%s linhas)\n' "$f" "$(wc -l <"$f")"
  else printf '%-12s AUSENTE\n' "$f"; fi
done

echo
echo "== containers em execucao =="
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' 2>&1 | sed 's/^/  /' || true

echo
echo "== portas ocupadas (8080, 8081, 5173, 5432) =="
for p in 8080 8081 5173 5432; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "  $p: OCUPADA"
    exec 3<&- 3>&-
  else
    echo "  $p: livre"
  fi
done

echo
echo "== variaveis que o compose exige =="
grep -oE '\$\{[A-Z_]+' compose.yaml | tr -d '${' | sort -u | sed 's/^/  /'
