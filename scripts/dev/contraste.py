#!/usr/bin/env python3
"""contraste.py — calcula a razão WCAG dos pares que o teste de a11y mede.

Uso: python3 scripts/dev/contraste.py

O teste (`frontend/src/test/a11y.test.tsx`) mede 14 pares e exige 4,5:1 para
texto e 3:1 para fronteira/foco. Escolher hex "a olho" e descobrir depois que o
teste reprova custa uma rodada; aqui o número sai antes.
"""
from __future__ import annotations


def canais(hex_cor: str) -> tuple[float, float, float]:
    valor = hex_cor.lstrip("#")
    if len(valor) != 6:
        raise ValueError(f"esperado #rrggbb: {hex_cor}")
    pares = [int(valor[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(  # type: ignore[return-value]
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in pares
    )


def luminancia(hex_cor: str) -> float:
    r, g, b = canais(hex_cor)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def razao(frente: str, fundo: str) -> float:
    a, b = luminancia(frente), luminancia(fundo)
    claro, escuro = max(a, b), min(a, b)
    return (claro + 0.05) / (escuro + 0.05)


# --- Paleta candidata: "desenho técnico" (papel, tinta, sinal) ------------------
P = {
    "paper": "#F7F8F6",
    "surface": "#FFFFFF",
    "ink": "#0E1A20",
    "inkBody": "#20303A",
    "inkSubtle": "#33454F",
    "inkMuted": "#55666F",
    "rule": "#7B8A91",
    "signal": "#14625E",
    "onSignal": "#FFFFFF",
    "rust": "#A33528",
    "amberInk": "#6E4A06",
    "amberPaper": "#FBF3DF",
    "amberRule": "#8A5A0B",
    "greenInk": "#155E3B",
    "greenPaper": "#ECF6EF",
    "greenRule": "#1E6B45",
    "flag": "#7A4A08",
}

PARES = [
    ("text / bg", P["ink"], P["paper"], 4.5),
    ("textBody / surface", P["inkBody"], P["surface"], 4.5),
    ("textSubtle / surface", P["inkSubtle"], P["surface"], 4.5),
    ("textMuted / surface", P["inkMuted"], P["surface"], 4.5),
    ("link / bg", P["signal"], P["paper"], 4.5),
    ("onLink / link", P["onSignal"], P["signal"], 4.5),
    ("warnText / warnSurface", P["amberInk"], P["amberPaper"], 4.5),
    ("flagText / surface", P["flag"], P["surface"], 4.5),
    ("successText / successSurface", P["greenInk"], P["greenPaper"], 4.5),
    ("focus / bg", P["signal"], P["paper"], 3.0),
    ("border / surface", P["rule"], P["surface"], 3.0),
    ("danger / surface", P["rust"], P["surface"], 3.0),
    ("warn / warnSurface", P["amberRule"], P["amberPaper"], 3.0),
    ("success / successSurface", P["greenRule"], P["greenPaper"], 3.0),
]

falhas = 0
largura = max(len(nome) for nome, *_ in PARES)
for nome, frente, fundo, piso in PARES:
    valor = razao(frente, fundo)
    ok = valor >= piso
    if not ok:
        falhas += 1
    marca = "ok  " if ok else "FALHA"
    print(f"  {marca} {nome:<{largura}}  {valor:5.2f}  (piso {piso})  {frente} sobre {fundo}")

print()
if falhas:
    print(f"{falhas} par(es) abaixo do piso — ajustar antes de escrever os tokens")
    raise SystemExit(1)
print("todos os pares passam")
