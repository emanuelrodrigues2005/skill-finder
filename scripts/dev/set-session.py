#!/usr/bin/env python3
"""set-session.py — grava as 3 credenciais da sessao no academy-env, sem ecoar.

Os valores vem por stdin em tres linhas (id, secret, token) e NAO sao impressos.
Substitui apenas as linhas `export AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN` e
preserva o resto do arquivo (regiao, bucket, a funcao academy_whoami).
"""
from __future__ import annotations

import pathlib
import re
import sys

DESTINO = pathlib.Path.home() / ".local/bin/academy-env"

linhas = sys.stdin.read().splitlines()
if len(linhas) < 3 or any(not v.strip() for v in linhas[:3]):
    print("FALHA: esperava 3 valores nao vazios", file=sys.stderr)
    raise SystemExit(2)

access, secret, token = (v.strip() for v in linhas[:3])

if not DESTINO.exists():
    print(f"FALHA: {DESTINO} nao existe", file=sys.stderr)
    raise SystemExit(3)

texto = DESTINO.read_text(encoding="utf-8")
subs = {
    "AWS_ACCESS_KEY_ID": access,
    "AWS_SECRET_ACCESS_KEY": secret,
    "AWS_SESSION_TOKEN": token,
}
for nome, valor in subs.items():
    padrao = rf"^export {nome}=.*$"
    novo = f"export {nome}='{valor}'"
    if not re.search(padrao, texto, flags=re.MULTILINE):
        print(f"FALHA: linha export {nome} nao encontrada", file=sys.stderr)
        raise SystemExit(4)
    texto = re.sub(padrao, novo, texto, flags=re.MULTILINE)

DESTINO.write_text(texto, encoding="utf-8")
DESTINO.chmod(0o700)

# Relatorio sem valores: so comprimento e prefixo do access key (que e publico).
print(f"academy-env atualizado: {DESTINO}")
print(f"  access_key: {len(access)} chars, prefixo {access[:8]}…")
print(f"  secret: {len(secret)} chars")
print(f"  token: {len(token)} chars")
