#!/usr/bin/env bash
# diag-search.sh — o loop do bug "a busca nao usa a intencao".
#
# Fase 1 do /diagnosing-bugs: um comando unico, deterministico e rapido contra a
# API viva, que assere os DOIS sintomas relatados:
#   1. consultas diferentes devolvem a mesma ordem (ou lista vazia)
#   2. a intencao extraida nao representa a consulta (keywords pobres)
#
# Contrato real da resposta (medido em 2026-11-25):
#   intent: {category, keywords[], confidence, language}
#   llm:    {status, model, cached, tokens{prompt,completion}}
#   data:   {degraded, degraded_reason, source, catalog_snapshot, age_seconds}
#   results: [{skill_id, score, ...}]
#
# Uso:
#   bash scripts/dev/diag-search.sh
#   BASE=http://localhost:8080 bash scripts/dev/diag-search.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ -z "${BASE:-}" ]; then
  source ~/.local/bin/academy-env >/dev/null 2>&1
  ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
  BASE="http://${ALB}"
fi
echo "API: ${BASE}"

CONSULTAS=(
  "quero uma skill para design frontend"
  "quero uma skill para desenvolvimento dirigido por testes"
  "skill para revisar pull requests procurando problemas de seguranca"
)

ORDENS=()
KW=""
i=0
for q in "${CONSULTAS[@]}"; do
  i=$((i + 1))
  # X-Forwarded-For diferente por consulta: o rate limit e 10/min por cliente e o
  # loop precisa de 3 sem esperar 60 s.
  resp="$(curl -sS -m 45 -X POST "${BASE}/api/v1/search" \
    -H 'content-type: application/json' \
    -H "X-Forwarded-For: 203.0.113.$((100 + i))" \
    -d "{\"query\":\"${q}\",\"limit\":5}" 2>&1)"

  linha="$(printf '%s' "$resp" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_ERRO||||"); raise SystemExit
intent = d.get("intent") or {}
llm = d.get("llm") or {}
data = d.get("data") or {}
res = d.get("results") or []
ordem = "|".join(f"{r.get(chr(115)+chr(107)+chr(105)+chr(108)+chr(108)+chr(95)+chr(105)+chr(100))}:{r.get(chr(115)+chr(99)+chr(111)+chr(114)+chr(101))}" for r in res) or "VAZIO"
print("\t".join([
    str(intent.get("keywords")),
    str(intent.get("confidence")),
    str(llm.get("status")),
    str(llm.get("model")),
    str(data.get("degraded_reason")),
    str(len(res)),
    ordem,
]))
' 2>/dev/null)"

  IFS=$'\t' read -r kw conf st modelo motivo n ordem <<< "$linha"
  echo "[$i] $q"
  echo "    keywords=${kw} conf=${conf} llm=${st} modelo=${modelo} motivo=${motivo} n=${n}"
  echo "    ordem: ${ordem}"
  ORDENS+=("$ordem")
  KW="${KW}${kw}
"
done

echo
echo "== veredito =="
distintas="$(printf '%s\n' "${ORDENS[@]}" | sort -u | wc -l)"
vazias="$(printf '%s\n' "${ORDENS[@]}" | grep -c '^VAZIO$' || true)"
echo "  ordens distintas ... ${distintas} de ${#ORDENS[@]}"
echo "  consultas vazias ... ${vazias}"
falhas=0
if [ "$distintas" -le 1 ]; then
  echo "  FALHA: toda consulta devolve a mesma ordem (ou lista vazia) — sintoma 1"
  falhas=$((falhas + 1))
fi
if printf '%s' "$KW" | grep -q '\[.quero.\]'; then
  echo "  FALHA: a intencao degradou para 'quero' — sintoma 2 (LLM sem efeito)"
  falhas=$((falhas + 1))
fi
if [ "$falhas" -gt 0 ]; then
  echo "  VERMELHO (${falhas} sintoma(s))"
  exit 1
fi
echo "  VERDE: intencao varia e a ordem acompanha"
