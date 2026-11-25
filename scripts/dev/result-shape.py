#!/usr/bin/env python3
"""result-shape.py — mostra a estrutura real de um item de `results`.

Serve para o loop de diagnostico parar de adivinhar nomes de campo: eu ja errei
`skill_id` e `name` lendo o JSON "de cabeca".
"""
from __future__ import annotations

import json
import random
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://skill-finder-alb-1500290765.us-east-1.elb.amazonaws.com"
QUERY = sys.argv[2] if len(sys.argv) > 2 else "quero uma skill para design frontend"

corpo = json.dumps({"query": QUERY, "limit": 3}).encode()
req = urllib.request.Request(
    f"{BASE}/api/v1/search",
    data=corpo,
    headers={
        "content-type": "application/json",
        "X-Forwarded-For": f"198.20.{random.randint(1, 250)}.{random.randint(1, 250)}",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
    d = json.loads(resp.read().decode())

print("chaves da resposta:", sorted(d.keys()))
res = d.get("results") or []
print(f"itens: {len(res)}")
if res:
    print("\nchaves do item:", sorted(res[0].keys()))
    print("\nprimeiro item (json):")
    print(json.dumps(res[0], ensure_ascii=False, indent=2)[:1200])
