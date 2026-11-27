#!/usr/bin/env python3
"""dash-queries.py — lista as consultas (LogQL/PromQL) dos paineis do dashboard.

Serve para saber se o painel de log filtra `level="error"` (e entao um 4xx `warn`
nao apareceria) ou se mostra qualquer linha da API.
"""
from __future__ import annotations

import json
from pathlib import Path

DASH = Path("observability/grafana/dashboards/main.json")


def main() -> int:
    d = json.loads(DASH.read_text(encoding="utf-8"))
    for painel in d.get("panels", []):
        titulo = painel.get("title")
        for alvo in painel.get("targets") or []:
            expr = alvo.get("expr") or alvo.get("query")
            if expr:
                print(f"[{titulo}]\n  {expr}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
