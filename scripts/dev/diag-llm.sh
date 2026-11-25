#!/usr/bin/env bash
# diag-llm.sh — taxa de sucesso da chamada a LLM na busca.
#
# Por que existe: duas buscas seguidas deram resultados opostos — uma com
# `model: deepseek-v4.1-flash` e keywords boas, outra com `model: null`,
# `tokens: null` e keywords `["quero"]`. Antes de corrigir o fallback, preciso
# saber se a LLM esta fora do ar de vez ou falhando intermitentemente.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

if [ -z "${BASE:-}" ]; then
  source ~/.local/bin/academy-env >/dev/null 2>&1
  ALB="$(terraform -chdir=infra output -raw alb_dns_name 2>/dev/null)"
  BASE="http://${ALB}"
fi
N="${1:-6}"
echo "API: ${BASE}   amostras: ${N}"
echo

cat > /tmp/llm-probe.py <<'PY'
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_ERRO"); raise SystemExit
llm = d.get("llm") or {}
intent = d.get("intent") or {}
res = d.get("results") or []
print("\t".join([
    str(llm.get("status")),
    "model=" + str(llm.get("model")),
    "tok=" + str((llm.get("tokens") or {}) and "sim" or "nao"),
    "conf=" + str(intent.get("confidence")),
    "kw=" + str(intent.get("keywords")),
    "n=" + str(len(res)),
]))
PY

ok=0
for i in $(seq 1 "$N"); do
  resp="$(curl -sS -m 45 -X POST "${BASE}/api/v1/search" \
    -H 'content-type: application/json' \
    -H "X-Forwarded-For: 198.18.$i.$((RANDOM % 200 + 1))" \
    -d '{"query":"quero uma skill para design frontend","limit":5}' 2>&1)"
  linha="$(printf '%s' "$resp" | python3 /tmp/llm-probe.py 2>/dev/null)"
  echo "[$i] ${linha}"
  case "$linha" in
    *"model=None"*|*"PARSE"*) ;;
    *) ok=$((ok + 1)) ;;
  esac
done

echo
echo "chamadas com modelo: ${ok}/${N}"
