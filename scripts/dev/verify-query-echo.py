#!/usr/bin/env python3
"""verify-query-echo.py — confirma que a pergunta volta do servidor e que o rank esta certo.

Verifica o que a transcricao precisa para o primeiro turno existir, e a assercao
do dono (design frontend -> frontend-design em 1o).
"""
from __future__ import annotations

import json
import random
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://skill-finder-alb-1500290765.us-east-1.elb.amazonaws.com"
QUERY = sys.argv[2] if len(sys.argv) > 2 else "quero uma skill para design frontend"

corpo = json.dumps({"query": QUERY, "limit": 5}).encode()
req = urllib.request.Request(
    f"{BASE}/api/v1/search",
    data=corpo,
    headers={
        "content-type": "application/json",
        "X-Forwarded-For": f"198.31.{random.randint(1, 250)}.{random.randint(1, 250)}",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=90) as resp:  # noqa: S310
    d = json.loads(resp.read().decode())

print(f"enviada ....... {QUERY!r}")
print(f"query devolvida {d.get('query')!r}")
print(f"bate? ......... {'SIM' if d.get('query') == QUERY else 'NAO'}")
print(f"request_id .... {d.get('request_id')}")
print(f"llm ........... {d.get('llm', {}).get('status')} model={d.get('llm', {}).get('model')}")
print()
for r in (d.get("results") or [])[:5]:
    s = r.get("skill") or {}
    print(f"  {r.get('rank')}. {s.get('name')}  score={r.get('score')}  cat={s.get('category')}")
