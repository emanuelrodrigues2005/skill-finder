#!/usr/bin/env bash
# probe-opencode-post.sh — POST sem chave nas candidatas de chat.
#
# `GET /chat/completions` responde 404 em toda parte (a rota é POST-only), então o
# GET não distingue "path inexistente" de "método errado". Um POST SEM chave:
#   401 -> a rota existe e só falta credencial (path certo)
#   404 -> o path não existe ali
#   405/400/422 -> também indicam que a rota existe
set -uo pipefail

testar() {
  local url="$1" codigo corpo
  corpo="$(mktemp)"
  codigo="$(curl -sS -m 20 -o "$corpo" -w '%{http_code}' \
    -X POST "$url" \
    -H 'content-type: application/json' \
    -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":1}' \
    2>/dev/null || echo 'ERR')"
  printf '  %-4s %s\n' "$codigo" "$url"
  # 3 primeiras linhas do corpo, para ver o formato do erro (OpenAI-like ou não)
  head -c 300 "$corpo" | tr '\n' ' ' | sed 's/^/        corpo: /'
  echo
  rm -f "$corpo"
}

echo "== POST sem Authorization =="
testar 'https://opencode.ai/zen/go/v1/chat/completions'
testar 'https://opencode.ai/inference/go/openai/v1/chat/completions'
testar 'https://opencode.ai/inference/openai/v1/chat/completions'
testar 'https://opencode.ai/inference/go/v1/chat/completions'
