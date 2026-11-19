#!/usr/bin/env bash
# probe-glm.sh — o que o catalogo do opencode diz sobre glm-5.3 e sobre esforco.
set -uo pipefail

echo "== modelos com 'glm' no catalogo Go =="
curl -sS -m 25 'https://opencode.ai/inference/go/v1/models' 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
itens = d.get("data") or d.get("models") or []
for m in itens:
    mid = m.get("id", "")
    if "glm" in mid.lower():
        print("  id:", mid)
        for chave in ("name", "canonical_id", "recommended_api"):
            if m.get(chave):
                print("    ", chave, ":", m[chave])
        cap = m.get("capabilities") or {}
        for chave in ("reasoning", "effort", "reasoning_effort", "structured_output", "tools"):
            if chave in cap:
                print("     capabilities." + chave + ":", json.dumps(cap[chave])[:160])
        lim = m.get("limit") or {}
        if lim:
            print("     limit:", json.dumps(lim))
' 2>/dev/null || echo "  (falhou ao ler o catalogo)"

echo
echo "== algum campo de esforco citado no catalogo inteiro? =="
curl -sS -m 25 'https://opencode.ai/inference/go/v1/models' 2>/dev/null \
  | grep -o -E '"[a-z_]*effort[a-z_]*"[^,}]{0,80}' | sort -u | head -10 | sed 's/^/  /'
echo "  (vazio = o catalogo nao documenta esforco)"
