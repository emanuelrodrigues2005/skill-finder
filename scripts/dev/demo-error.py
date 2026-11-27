#!/usr/bin/env python3
"""demo-error.py — injeta um erro na API e prova que ele aparece no Loki.

Por que existe: para a gravacao, o dono precisa de um erro que (a) seja seguro de
disparar ao vivo e (b) apareca no Grafana em segundos. Este script dispara,
espera o Promtail empurrar e consulta a MESMA linha no Loki pelo `request_id`.

Uso: python3 scripts/dev/demo-error.py [URL_BASE]
"""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://skill-finder-alb-1821924809.us-east-1.elb.amazonaws.com"
GRAFANA_USER = "ejtr2005"
GRAFANA_PASS = "PKiamp6VfKzLVlZxFDdC"


def post_invalido() -> tuple[int, dict]:
    """422: corpo sem `query`. Nao cria busca, nao gasta LLM, nao consome cota real."""
    req = urllib.request.Request(
        f"{BASE}/api/v1/search",
        data=json.dumps({"limit": 5}).encode(),
        headers={"content-type": "application/json", "X-Forwarded-For": "198.40.10.10"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        corpo = e.read().decode()
        try:
            return e.code, json.loads(corpo)
        except Exception:  # noqa: BLE001
            return e.code, {"raw": corpo[:300]}


def loki(query: str, minutos: int = 10) -> dict:
    """Consulta o Loki pelo proxy do Grafana (mesma origem do ALB)."""
    fim = int(time.time() * 1e9)
    inicio = fim - minutos * 60 * int(1e9)
    params = urllib.parse.urlencode(
        {"query": query, "start": str(inicio), "end": str(fim), "limit": "20", "direction": "backward"}
    )
    url = f"{BASE}/grafana/api/datasources/proxy/uid/loki/loki/api/v1/query_range?{params}"
    token = base64.b64encode(f"{GRAFANA_USER}:{GRAFANA_PASS}".encode()).decode()
    req = urllib.request.Request(url, headers={"Authorization": f"Basic {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310
        return json.loads(r.read().decode())


def main() -> int:
    print(f"API: {BASE}")
    print()
    status, corpo = post_invalido()
    rid = (corpo.get("request_id") or (corpo.get("error") or {}).get("request_id")) if isinstance(corpo, dict) else None
    print(f"== request injetado ==")
    print(f"  status: {status}")
    print(f"  corpo : {json.dumps(corpo, ensure_ascii=False)[:200]}")
    print(f"  request_id: {rid}")
    if not rid:
        print("  AVISO: sem request_id na resposta; a busca no Loki sera por rota+status")

    print()
    print("== aguardando o Promtail (3 s) ==")
    time.sleep(3)

    alvo = f'{{service="api"}} |= "{rid}"' if rid else '{service="api"} | json | status >= 400'
    print(f"  LogQL: {alvo}")
    try:
        d = loki(alvo)
    except Exception as erro:  # noqa: BLE001
        print(f"  FALHA ao consultar o Loki: {erro}")
        return 1

    streams = d.get("data", {}).get("result", [])
    linhas = [v for s in streams for v in s.get("values", [])]
    print(f"  linhas encontradas: {len(linhas)}")
    for _, linha in linhas[:5]:
        print(f"    {linha[:220]}")
    if not linhas:
        print("  (nada ainda — o batch do Promtail e de 1 s; tente de novo em segundos)")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
