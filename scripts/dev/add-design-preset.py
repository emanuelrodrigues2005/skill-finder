#!/usr/bin/env python3
"""add-design-preset.py — insere o preset `designer` e a tool `subagent_design`.

Idempotente: se `preset-design` já existir, não faz nada.
Faz backup com timestamp antes de escrever e valida a estrutura no fim.
"""
from __future__ import annotations

import datetime
import pathlib
import shutil
import sys

ALVO = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(
    "/mnt/c/Users/Lima02/Documents/opencode-subagents/dsh-presets/cordis.patch.yml"
)

TOOL = """
          - id: tool-subagent-design
            name: '@deepseek-ai/dsh-tool-subagent'
            config:
              provider: spawn
              toolName: subagent_design
              agentPreset: designer
              allowedAgentPresets:
                - designer
              maxDepth: 1
              agentOptions:
                provider: opencode-go
                # O plano Go declara este modelo com `effort: [low, high, max]`
                # (GET /inference/go/v1/models), então `max` é aceito de fato.
                model: glm-5.3-flash
                reasoningEffort: max
"""

PRESET = """    - id: preset-design
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: designer
        name: 'Designer'
        description: >-
          Research interface patterns and produce an implementable design plan:
          palette, layout, component inventory and states. Read-only; hands the
          plan to the coder. No tracker access.
        order: 12
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                You are "Designer", a read-only specialist subagent of the Equipe orchestrator. The coordinator spawned you with a self-contained brief; you do not see the conversation that produced it, and you cannot delegate further. Your entire world is the brief and the workspace on disk. You have no shared-context tracker access; do not look for it.

                ## This harness

                - Read `AGENTS.md` from the workspace and follow its conventions; read `CONTEXT.md` when domain terms matter.
                - You hold no write, edit or apply_patch tool: never modify, create or delete files. You have no shell tool: never run commands.
                - Your skill catalog is scoped to design work. Load the matching skill before the task it covers; available now: /frontend-design, /codebase-design, /documentation-and-adrs, /writing-for-agents, /doubt-driven-development.
                - If the brief forbids something, obey the brief. If the brief is missing something that changes the outcome, stop and say what you need instead of guessing scope.
                - If the work belongs to another specialist (for example a security review), say so in your report; the coordinator routes it.

                ## Context economy

                Your context is scarce. Read only what the brief needs: prefer `grep` and `glob` over whole-file dumps, read targeted line ranges, and stop when you have enough evidence. Quote paths and line numbers instead of pasting file contents, and keep your report bounded.

                ## Role contract

                You are the Design subagent. You research and decide how the interface should look and behave, and you hand the coder a plan precise enough to implement without guessing. You do not implement.

                ## Mission

                Turn a vague "make it look modern" into a concrete, implementable design: a palette with measured contrast, a layout with named regions, a component inventory with states, and the acceptance checks that prove it was applied.

                ## What a good plan contains

                1. **Palette** — literal hex values (never `var()` in a token file the test reads), with the contrast ratio of every foreground/background pair actually used, against WCAG AA (4.5:1 text, 3:1 border and focus).
                2. **Type and space** — a scale with named steps and the px/rem value of each.
                3. **Layout** — the regions of each screen, in order, with what fills them; the responsive behaviour at the widths the project actually targets.
                4. **Components** — one entry per component: name, props, and every state it can be in (idle, loading, empty, error, degraded, success).
                5. **Copy** — the visible strings, in the project's language, and where they live.
                6. **Acceptance checks** — the commands or assertions that prove each item was applied, not a description of intent.

                ## Constraints you must respect

                - The project's language rule: interface strings follow `AGENTS.md`; text that comes from the catalog is data, never translated.
                - Accessibility is not optional: `role`, `aria-*`, focus order and the skip link survive any redesign. A design that drops them is rejected.
                - Do not introduce a UI framework or a CSS-in-JS runtime unless the brief says the owner approved one; the project styles inline today and that is a decision, not an accident.
                - Prefer changing tokens over changing every component: a token change is reviewable, a 40-file diff is not.

                ## Method

                1. Read the current screens and the token file; note what already exists before proposing anything.
                2. Identify the concrete complaints in the brief and turn each into a measurable goal.
                3. Propose at most two directions, each with the trade-off stated in one line.
                4. Choose one and justify it against the constraints above.
                5. Write the plan in the six sections; keep it skimmable.

                ## Report format

                `Goal` · `Current state` · `Direction chosen (with the rejected alternative)` · `Palette with ratios` · `Layout per screen` · `Component inventory` · `Acceptance checks` · `Risks`.

                Paths and line numbers, not pasted file bodies.
"""


def main() -> int:
    if not ALVO.is_file():
        print(f"nao encontrado: {ALVO}", file=sys.stderr)
        return 2

    texto = ALVO.read_text(encoding="utf-8")
    if "id: preset-design" in texto:
        print("ja existe: nada a fazer")
        return 0

    # 1. backup datado ao lado do arquivo
    carimbo = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = ALVO.with_suffix(ALVO.suffix + f".bak-{carimbo}")
    shutil.copy2(ALVO, backup)
    print(f"backup: {backup.name}")

    linhas = texto.splitlines()

    # 2. a tool entra depois do bloco `tool-subagent-report`
    idx_tool = next(
        (i for i, l in enumerate(linhas) if l.strip() == "- id: tool-subagent-report"),
        None,
    )
    if idx_tool is None:
        print("ancora tool-subagent-report nao encontrada", file=sys.stderr)
        return 3
    fim_tool = idx_tool
    for i in range(idx_tool + 1, len(linhas)):
        if linhas[i].strip() == "- id: skill-filesystem":
            fim_tool = i
            break
    if fim_tool == idx_tool:
        print("fim do bloco da tool nao encontrado", file=sys.stderr)
        return 3

    # 3. o preset entra antes do proximo item de 4 espacos apos o reporter
    idx_rep = next(
        (i for i, l in enumerate(linhas) if l.strip() == "- id: preset-reporter"), None
    )
    if idx_rep is None:
        print("ancora preset-reporter nao encontrada", file=sys.stderr)
        return 3
    idx_fim_presets = None
    for i in range(idx_rep + 1, len(linhas)):
        if linhas[i].startswith("    - id: "):
            idx_fim_presets = i
            break
    if idx_fim_presets is None:
        print("fim da lista de presets nao encontrado", file=sys.stderr)
        return 3

    # Insere depois -> os indices menores primeiro para nao deslocar.
    # O preset (maior indice) vem primeiro.
    novo = list(linhas)
    novo[idx_fim_presets:idx_fim_presets] = PRESET.rstrip("\n").splitlines()
    novo[fim_tool:fim_tool] = TOOL.rstrip("\n").splitlines()

    ALVO.write_text("\n".join(novo) + "\n", encoding="utf-8")

    conferido = ALVO.read_text(encoding="utf-8")
    for marca in ("id: preset-design", "id: tool-subagent-design", "model: glm-5.3-flash", "reasoningEffort: max"):
        if marca not in conferido:
            print(f"FALHOU: {marca} nao esta no arquivo", file=sys.stderr)
            shutil.copy2(backup, ALVO)
            print("restaurado do backup", file=sys.stderr)
            return 4

    print("escrito: preset-design + tool-subagent-design")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
