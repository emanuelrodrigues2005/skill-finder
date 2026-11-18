#!/usr/bin/env bash
# up-now.sh — garante o projeto no ar e imprime a URL, com prova HTTP.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== 1. estado dos containers =="
docker compose --profile dev ps -a --format 'table {{.Name}}\t{{.Status}}\t{{.Ports}}'

rodando="$(docker compose --profile dev ps --services --status running 2>/dev/null | tr '\n' ' ')"
echo
echo "  servicos rodando: ${rodando:-nenhum}"

for s in postgres api-dev web; do
  if ! docker compose --profile dev ps --services --status running 2>/dev/null | grep -qx "$s"; then
    echo
    echo "== $s não está rodando — subindo o stack =="
    timeout 900 make up || { echo "make up falhou"; exit 1; }
    break
  fi
done

echo
echo "== 2. seed (idempotente: a segunda execucao nao duplica) =="
timeout 300 make seed 2>&1 | tail -3

echo
echo "== 3. prova HTTP =="
for url in http://127.0.0.1:8080/healthz http://127.0.0.1:8081/; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)"
  printf '  %-32s HTTP %s\n' "$url" "$code"
done

echo
echo "== 4. o HTML que o navegador recebe em :8081 =="
curl -sS --max-time 10 http://127.0.0.1:8081/ | sed -n '1,14p'

echo
echo "== 5. a SPA faz o proxy da API? =="
curl -sS --max-time 10 -w '\n  HTTP %{http_code}\n' http://127.0.0.1:8081/api/v1/skills | head -c 400
echo
echo
echo "== 6. busca pelo proxy do nginx (o caminho do navegador) =="
curl -sS --max-time 20 -H 'content-type: application/json' \
  -d '{"query":"skills","limit":3}' \
  http://127.0.0.1:8081/api/v1/search \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
    console.log(`  results=${r.results.length} degraded=${r.data.degraded}`);
    r.results.forEach((x,i)=>console.log(`  #${i+1} ${x.skill.name} score=${x.score}`));});'

echo
echo "  >>> ABRA: http://localhost:8081"
