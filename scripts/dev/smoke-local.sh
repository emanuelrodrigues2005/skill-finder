#!/usr/bin/env bash
# smoke-local.sh — smoke funcional do stack local (o que o usuário vai fazer no navegador).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

busca() {
  local q="$1"
  echo "-- POST /search {query: \"$q\"}"
  curl -sS --max-time 20 \
    -H 'content-type: application/json' \
    -d "{\"query\":\"$q\",\"limit\":3}" \
    http://127.0.0.1:8080/api/v1/search \
  | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const r=JSON.parse(s);
        console.log(`   results=${r.results.length} degraded=${r.data.degraded} reason=${r.data.degraded_reason} llm=${r.llm.status}`);
        r.results.slice(0,3).forEach((x,i)=>{
          console.log(`   #${i+1} rank=${x.rank} score=${x.score} ${x.skill.skill_id} ${x.skill.name} installs=${x.skill.installs}`);
        });
        if(r.warnings.length) console.log(`   warnings=${JSON.stringify(r.warnings)}`);
      });'
}

busca "find skills for webapp testing"
busca "skills"

echo
echo "-- GET /api/v1/skills/sk_00000000000000000001"
curl -sS --max-time 10 http://127.0.0.1:8080/api/v1/skills/sk_00000000000000000001 \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const d=r.data;console.log(`   name=${d.name} stars=${d.stars} installs=${d.installs} vulns=${d.vulnerability_count} data_snapshot=${d.data_snapshot}`);});'

echo
echo "-- web (SPA) serve o index?"
curl -sS --max-time 5 http://127.0.0.1:8081/ | head -3 | sed 's/^/   /'
