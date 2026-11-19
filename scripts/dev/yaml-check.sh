#!/usr/bin/env bash
# yaml-check.sh — valida a estrutura do cordis.patch.yml sem quebrar nos `!!js`.
#
# O arquivo usa a tag customizada `!!js` (valores computados em runtime), que o
# parser YAML comum rejeita. Aqui registramos um construtor para essa tag: o valor
# vira um placeholder e o que se valida é a ESTRUTURA (chaves, listas, indentação)
# — exatamente o que quebra o harness quando erra.
set -uo pipefail

ALVO="${1:?informe o caminho do cordis.patch.yml}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 ausente" >&2
  exit 2
fi

python3 - "$ALVO" <<'PY'
import sys

try:
    import yaml
except ImportError:
    print("  pyyaml ausente: validacao estrutural nao executada")
    raise SystemExit(3)


class Carregador(yaml.SafeLoader):
    """SafeLoader com a tag `!!js` (e `!js`) resolvida para um placeholder."""


def _placeholder(loader, no):
    return "<js>"


Carregador.add_constructor("tag:yaml.org,2002:js", _placeholder)
Carregador.add_constructor("!js", _placeholder)

caminho = sys.argv[1]
try:
    doc = yaml.load(open(caminho, encoding="utf-8"), Loader=Carregador)
except Exception as erro:
    print("  YAML INVALIDO:", str(erro).splitlines()[0])
    raise SystemExit(1)

if doc is None:
    print("  YAML vazio")
    raise SystemExit(1)


def coletar(no, presets, ferramentas):
    if isinstance(no, dict):
        ident = no.get("id")
        if isinstance(ident, str):
            if ident.startswith("preset-"):
                presets.append(ident)
            if ident.startswith("tool-subagent"):
                ferramentas.append(ident)
        for valor in no.values():
            coletar(valor, presets, ferramentas)
    elif isinstance(no, list):
        for valor in no:
            coletar(valor, presets, ferramentas)


presets, ferramentas = [], []
coletar(doc, presets, ferramentas)
print("  YAML valido")
print("  presets:", len(presets), "->", ", ".join(presets))
print("  ferramentas de subagente:", len(ferramentas), "->", ", ".join(ferramentas))
PY
