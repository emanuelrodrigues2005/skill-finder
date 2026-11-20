#!/usr/bin/env bash
# probe-opencode.sh — descobre qual base URL do gateway do opencode responde.
#
# Sem chave: `/models` é público nas bases documentadas, então o status HTTP já
# separa "existe" de "não existe". É a diferença entre um 404 de path errado e um
# 401 de credencial faltando — sintomas que se confundem.
set -uo pipefail

CANDIDATAS=(
  "https://opencode.ai/zen/go/v1/models"
  "https://opencode.ai/inference/go/v1/models"
  "https://opencode.ai/inference/openai/v1/models"
  "https://opencode.ai/inference/v1/models"
  "https://opencode.ai/zen/go/v1/chat/completions"
  "https://opencode.ai/inference/go/openai/v1/chat/completions"
)

echo "== GET sem chave (o status separa path inexistente de credencial) =="
for url in "${CANDIDATAS[@]}"; do
  # -L segue redirect; -m 15 evita travar; -o /dev/null descarta o corpo.
  codigo="$(curl -sS -L -m 15 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 'ERR')"
  printf '  %-3s  %s\n' "$codigo" "$url"
done

echo
echo "== o catalogo Go declara qual base_url para o deepseek-v4.1-flash? =="
corpo="$(curl -sS -L -m 20 'https://opencode.ai/inference/go/v1/models' 2>/dev/null || true)"
if [ -n "$corpo" ]; then
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$corpo" | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print("  nao e JSON:", e); raise SystemExit
itens = d.get("data") or d.get("models") or []
for m in itens:
    if "deepseek" in json.dumps(m).lower():
        print("  id:", m.get("id"))
        print("  base_url:", m.get("base_url"))
        print("  api:", m.get("recommended_api"))
' 2>/dev/null || echo "  (python falhou)"
  else
    printf '%s' "$corpo" | grep -o '"base_url":"[^"]*"' | sort -u | sed 's/^/  /'
  fi
else
  echo "  catalogo indisponivel"
fi
