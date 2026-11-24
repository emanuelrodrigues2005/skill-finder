#!/usr/bin/env python3
"""yaml-parse.py — valida a sintaxe de um YAML sem depender de shell quoting."""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FALHA: pyyaml ausente", file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) < 2:
    print("uso: yaml-parse.py <arquivo>...", file=sys.stderr)
    raise SystemExit(2)

falhas = 0
for nome in sys.argv[1:]:
    caminho = Path(nome)
    if not caminho.exists():
        print(f"  FALTA {nome}")
        falhas += 1
        continue
    try:
        yaml.safe_load(caminho.read_text(encoding="utf-8"))
        print(f"  OK    {nome}")
    except Exception as erro:
        print(f"  FALHA {nome}: {erro}")
        falhas += 1

raise SystemExit(1 if falhas else 0)
