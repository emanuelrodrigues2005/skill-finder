#!/usr/bin/env python3
"""add-query-fixture.py — insere `query` nos objetos SearchResponse dos testes.

O contrato passou a exigir `query: string | null` (obrigatorio e nullable), e os
fixtures foram escritos antes disso. Inserir a chave logo depois de `search_id` e
mecanico e evita reescrever 10 objetos a mao — e mantem o tipo do frontend fiel ao
contrato em vez de afrouxa-lo para opcional.

Uso: python3 scripts/dev/add-query-fixture.py <arquivo>...
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ALVO = re.compile(r"^(\s*)search_id:\s*(['\"])(.*?)\2,\s*$")
JA_TEM = re.compile(r"^\s*query:", re.MULTILINE)


def patch(caminho: Path) -> int:
    linhas = caminho.read_text(encoding="utf-8").splitlines(keepends=True)
    saida: list[str] = []
    inseridos = 0
    for i, linha in enumerate(linhas):
        saida.append(linha)
        m = ALVO.match(linha.rstrip("\n"))
        if not m:
            continue
        # Nao duplica: so insere se a proxima linha ainda nao for `query:`.
        proxima = linhas[i + 1] if i + 1 < len(linhas) else ""
        if JA_TEM.match(proxima):
            continue
        indent, _, _ = m.groups()
        saida.append(f"{indent}query: 'extrair tabelas de pdf',\n")
        inseridos += 1
    if inseridos:
        caminho.write_text("".join(saida), encoding="utf-8")
    return inseridos


def main() -> int:
    total = 0
    for nome in sys.argv[1:]:
        p = Path(nome)
        if not p.exists():
            print(f"  FALTA {nome}")
            continue
        n = patch(p)
        total += n
        print(f"  {nome}: {n} insercao(oes)")
    print(f"total: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
