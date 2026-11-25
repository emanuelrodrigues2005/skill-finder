#!/usr/bin/env python3
"""catalog-shape.py — imprime o catalogo da API sem depender de aspas no shell.

Uso: python3 scripts/dev/catalog-shape.py [URL_BASE]
"""
from __future__ import annotations

import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://skill-finder-alb-1500290765.us-east-1.elb.amazonaws.com"


def get(path: str):
    req = urllib.request.Request(
        f"{BASE}{path}",
        headers={"X-Forwarded-For": "203.0.113.251", "accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
        return json.loads(resp.read().decode())


def main() -> int:
    print("== /api/v1/skills ==")
    try:
        d = get("/api/v1/skills?limit=100")
        itens = d.get("data") or d.get("results") or d.get("items") or []
        print(f"  total: {len(itens)}")
        meta = d.get("meta")
        if meta:
            print(f"  meta: {json.dumps(meta, ensure_ascii=False)[:300]}")
        for x in itens[:20]:
            print(f"  - {x.get('skill_id')} | {x.get('name')} | cat={x.get('category')} | stars={x.get('stars')}")
    except Exception as erro:  # noqa: BLE001
        print(f"  erro: {erro}")

    print()
    print("== /api/v1/categories ==")
    try:
        d = get("/api/v1/categories")
        print(f"  {json.dumps(d.get('data'), ensure_ascii=False)[:400]}")
        print(f"  snapshot: {d.get('data_snapshot')}")
    except Exception as erro:  # noqa: BLE001
        print(f"  erro: {erro}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
