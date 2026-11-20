#!/usr/bin/env python3
"""sync-design-preset.py — instala o catálogo do preset `designer` e sincroniza o perfil.

Três passos, cada um idempotente:
  1. copia a skill `frontend-design` (instalada via `npx skills` em `~/.agents/skills`)
     para o skill set ATIVO do DSH (`~/.agents/skill-sets/equipe`);
  2. acrescenta `designer` ao `skills.json` do plugin de presets;
  3. copia o `cordis.patch.yml` da fonte para o perfil instalado que o harness lê.

O passo 3 existe porque os dois arquivos são o MESMO conteúdo versionado em lugares
diferentes: editar só a fonte não muda nada em runtime.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import sys

# O perfil e as skills vivem no home do Windows (`C:\Users\Lima02`), nao no home do
# WSL (`/home/lima02`): `pathlib.Path.home()` dentro do WSL aponta para o lugar
# errado e os tres passos falhariam em silencio com "AVISO".
HOME = pathlib.Path("/mnt/c/Users/Lima02")
FONTE = pathlib.Path("/mnt/c/Users/Lima02/Documents/opencode-subagents/dsh-presets")
SKILL_ORIGEM = HOME / ".agents" / "skills" / "frontend-design"
SKILL_SET = HOME / ".agents" / "skill-sets" / "equipe"
PERFIL = HOME / ".dsh" / "profiles" / "desktop" / "node_modules" / "dsh-preset-equipe"

SKILLS_DO_DESIGNER = [
    "frontend-design",
    "codebase-design",
    "documentation-and-adrs",
    "writing-for-agents",
    "doubt-driven-development",
]


def passo_skill() -> None:
    if not SKILL_ORIGEM.is_dir():
        print(f"  AVISO: skill nao encontrada em {SKILL_ORIGEM}")
        return
    destino = SKILL_SET / "frontend-design"
    if destino.exists():
        print("  skill: ja esta no set ativo")
        return
    shutil.copytree(SKILL_ORIGEM, destino)
    print(f"  skill: copiada para {destino}")


def passo_skills_json() -> None:
    alvo = FONTE / "skills.json"
    dados = json.loads(alvo.read_text(encoding="utf-8"))
    if "designer" in dados:
        print("  skills.json: 'designer' ja existe")
        return
    dados["designer"] = SKILLS_DO_DESIGNER
    alvo.write_text(json.dumps(dados, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # relê para provar que continua sendo JSON válido
    conferido = json.loads(alvo.read_text(encoding="utf-8"))
    assert conferido["designer"] == SKILLS_DO_DESIGNER
    print(f"  skills.json: 'designer' com {len(SKILLS_DO_DESIGNER)} skills")


def passo_perfil() -> None:
    origem = FONTE / "cordis.patch.yml"
    destino = PERFIL / "cordis.patch.yml"
    if not destino.parent.is_dir():
        print(f"  AVISO: perfil nao encontrado em {destino.parent}")
        return
    if destino.exists() and destino.resolve() == origem.resolve():
        # O perfil e SYMLINK para o repo: editar a fonte ja muda o runtime, e copiar
        # aqui falha com SameFileError (foi o que aconteceu na primeira execucao).
        print("  perfil: symlink para a fonte - nada a copiar")
    else:
        shutil.copy2(origem, destino)
        print(f"  perfil: sincronizado em {destino}")

    # o skills.json do plugin também precisa ir
    origem_json = FONTE / "skills.json"
    destino_json = PERFIL / "skills.json"
    if origem_json.is_file():
        if destino_json.exists() and destino_json.resolve() == origem_json.resolve():
            print("  perfil: skills.json tambem e symlink - nada a copiar")
        else:
            shutil.copy2(origem_json, destino_json)
            print("  perfil: skills.json sincronizado")


def main() -> int:
    if not FONTE.is_dir():
        print(f"fonte nao encontrada: {FONTE}", file=sys.stderr)
        return 2
    print("1. skill")
    passo_skill()
    print("2. catalogo por preset")
    passo_skills_json()
    print("3. perfil instalado")
    passo_perfil()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
