#!/usr/bin/env python3
"""loki.py — consulta o Loki pelo proxy do Grafana.

Uso:
  python3 scripts/dev/loki.py '<logql>' [minutos] [limite]

Existe para o dono (e para mim) conferirmos o que ja esta no Loki sem abrir o
navegador — a mesma query que o painel usa.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = os.environ.get("SF_BASE", "http://skill-finder-alb-1821924809.us-east-1.elb.amazonaws.com")
USER = os.environ.get("GF_USER", "ejtr2005")
SENHA = os.environ.get("GF_PASS", "PKiamp6VfKzLVlZxFDdC")


def consultar(query: str, minutos: int = 60, limite: int = 10) -> list[str]:
    fim = int(time.time() * 1e9)
    inicio = fim - minutos * 60 * int(1e9)
    params = urllib.parse.urlencode(
        {"query": query, "start": str(inicio), "end": str(fim), "limit": str(limite), "direction": "backward"}
    )
    url = f"{BASE}/grafana/api/datasources/proxy/uid/loki/loki/api/v1/query_range?{params}"
    tok = base64.b64encode(f"{USER}:{SENHA}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {tok}"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        d = json.loads(r.read().decode())
    return [linha for s in d.get("data", {}).get("result", []) for _, linha in s.get("values", [])]


def main() -> int:
    query = sys.argv[1] if len(sys.argv) > 1 else '{service=~"api(-dev)?", level="error"}'
    minutos = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    limite = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    print(f"LogQL: {query}   (ultimos {minutos} min)")
    linhas = consultar(query, minutos, limite)
    print(f"linhas: {len(linhas)}")
    for linha in linhas:
        print(f"  {linha[:240]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
