#!/usr/bin/env bash
# prove-url.sh — prova que a URL de entrada serve a aplicação e a API por trás dela.
set -uo pipefail
BASE="http://127.0.0.1:8081"

echo "== 1. HTML servido na raiz =="
curl -sS --max-time 10 "$BASE/" | sed -n '1,12p'

echo
echo "== 2. /api pela mesma origem (o que o navegador faz) =="
curl -sS --max-time 10 -w '\n  HTTP %{http_code}\n' "$BASE/api/v1/skills?page=1&page_size=2" | head -c 500

echo
echo "== 3. POST /search pela mesma origem =="
curl -sS --max-time 20 -H 'content-type: application/json' \
  -d '{"query":"skills","limit":3}' "$BASE/api/v1/search" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
    console.log(`  results=${r.results.length} degraded=${r.data.degraded} llm=${r.llm.status}`);
    r.results.forEach((x,i)=>console.log(`  #${i+1} rank=${x.rank} score=${x.score} ${x.skill.name}`));});'

echo
echo "== 4. rota interna da SPA (fallback do nginx) =="
for r in /skills/sk_00000000000000000001 "/results?search=req_x"; do
  printf '  %-40s HTTP %s\n' "$r" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE$r")"
done

echo
echo "== 5. API direta (para /docs e /metrics) =="
for u in http://127.0.0.1:8090/healthz http://127.0.0.1:8090/docs http://127.0.0.1:8090/metrics; do
  printf '  %-40s HTTP %s\n' "$u" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$u")"
done

echo
echo "  >>> ENTRAR EM: $BASE"
