#!/usr/bin/env python3
"""hosts.py — imprime id e papel (tag Name) de cada instancia rodando.

Le a saida de `aws ec2 describe-instances --output json` por stdin. Existe para
tirar do shell as aspas e chaves aninhadas que quebraram tres vezes seguidas
(JMESPath, f-string e `{}` comido pelo PowerShell).

A resposta do EC2 e um OBJETO com `Reservations[]`, cada uma com `Instances[]` —
iterar o objeto direto devolve as chaves, nao as instancias.
"""
from __future__ import annotations

import json
import sys


def instancias_de(resposta: object) -> list[dict]:
    if isinstance(resposta, dict):
        reservas = resposta.get("Reservations") or []
    elif isinstance(resposta, list):
        reservas = resposta
    else:
        return []
    saida: list[dict] = []
    for reserva in reservas:
        if isinstance(reserva, dict) and "Instances" in reserva:
            saida.extend(i for i in reserva["Instances"] if isinstance(i, dict))
        elif isinstance(reserva, dict) and "InstanceId" in reserva:
            saida.append(reserva)
    return saida


def main() -> int:
    bruto = sys.stdin.read().strip()
    if not bruto:
        print("  (vazio)")
        return 0
    try:
        dados = json.loads(bruto)
    except json.JSONDecodeError as erro:
        print(f"  FALHA ao ler JSON: {erro}")
        return 1

    instancias = instancias_de(dados)
    if not instancias:
        print("  nenhuma instancia rodando")
        return 0
    for item in instancias:
        tags = {t.get("Key"): t.get("Value") for t in (item.get("Tags") or [])}
        papel = tags.get("Name") or "?"
        print(f"  {item.get('InstanceId')}  {papel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
