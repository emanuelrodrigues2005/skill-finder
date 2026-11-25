#!/usr/bin/env python3
"""check-intent.py — intencao + NOMES retornados, na forma real da resposta.

Contrato medido em 2026-11-25:
  results[] = {rank, score, score_breakdown, evidence_completeness,
               skill: {skill_id, name, category, stars, installs, ...},
               explanation, flags, caveats}
"""
from __future__ import annotations

import json
import random
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://skill-finder-alb-1500290765.us-east-1.elb.amazonaws.com"
CONSULTAS = sys.argv[2:] or [
    "quero uma skill para design frontend",
    "quero uma skill que ajude a escrever testes antes do codigo",
    "preciso revisar seguranca de uma pull request",
]


def buscar(query: str):
    corpo = json.dumps({"query": query, "limit": 5}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/v1/search",
        data=corpo,
        headers={
            "content-type": "application/json",
            "X-Forwarded-For": f"198.21.{random.randint(1, 250)}.{random.randint(1, 250)}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:  # noqa: S310
        return json.loads(resp.read().decode())


def main() -> int:
    for q in CONSULTAS:
        print(f"\n=== {q}")
        try:
            d = buscar(q)
        except Exception as erro:  # noqa: BLE001
            print(f"  ERRO: {erro}")
            continue
        intent = d.get("intent") or {}
        llm = d.get("llm") or {}
        print(f"  keywords: {intent.get('keywords')}")
        print(f"  conf={intent.get('confidence')}  llm={llm.get('status')}  model={llm.get('model')}")
        for r in (d.get("results") or [])[:5]:
            s = r.get("skill") or {}
            print(f"    {r.get('rank')}. {s.get('name')}  score={r.get('score')}  cat={s.get('category')}")
        if not (d.get("results") or []):
            print("    (sem resultados)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
