#!/usr/bin/env python3
"""extrai-pdf.py — extrai o texto de um PDF para um .txt.

Tenta as bibliotecas disponiveis e, se nenhuma existir, cai para a extracao crua
de streams FlateDecode (suficiente para PDFs gerados por editor de texto).
"""
from __future__ import annotations

import re
import sys
import zlib
from pathlib import Path

ORIGEM = Path("/mnt/c/Users/Lima02/Downloads/Arquitetura_Cloud_AWS.pdf")
DESTINO = Path("/tmp/arq.txt")


def via_pypdf() -> str | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except Exception:
        return None
    leitor = PdfReader(str(ORIGEM))
    return "\n".join((p.extract_text() or "") for p in leitor.pages)


def via_fitz() -> str | None:
    try:
        import fitz  # type: ignore
    except Exception:
        return None
    doc = fitz.open(str(ORIGEM))
    return "\n".join(pagina.get_text() for pagina in doc)


def via_cru() -> str:
    bruto = ORIGEM.read_bytes()
    partes: list[str] = []
    for fluxo in re.findall(rb"stream\r?\n(.*?)endstream", bruto, re.S):
        try:
            dados = zlib.decompress(fluxo)
        except Exception:
            continue
        texto = re.findall(rb"\((.*?)\)\s*Tj", dados, re.S)
        if texto:
            partes.append(b" ".join(texto).decode("latin-1", "replace"))
    return "\n".join(partes)


def main() -> int:
    if not ORIGEM.exists():
        print(f"FALHA: {ORIGEM} nao existe", file=sys.stderr)
        return 2
    for nome, fn in (("pypdf", via_pypdf), ("fitz", via_fitz)):
        texto = fn()
        if texto:
            DESTINO.write_text(texto, encoding="utf-8")
            print(f"extraido com {nome}: {len(texto)} chars, {texto.count(chr(10))} linhas")
            return 0
    texto = via_cru()
    if not texto.strip():
        print("FALHA: nenhuma biblioteca e a extracao crua nao achou texto", file=sys.stderr)
        return 3
    DESTINO.write_text(texto, encoding="utf-8")
    print(f"extraido cru: {len(texto)} chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
