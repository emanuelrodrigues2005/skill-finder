# F2 — Checklist de UI (inglês, foco, erro, vazio, `n/a`)

**Data:** 2026-11-17
**Issue:** `fix(api): bloquear prompt injection e aplicar limites de uso` (#13), critério
“checklist de UI em inglês/foco/erro/vazio/`n/a` em `docs/evidencias/f2-ui.md`”
**Donos:** #25 (resultados), #26 (detalhe), #27 (estados/foco) e #28 (Vitest) — issues de
`frontend/` da mesma milestone, em `scripts/github/issues/f2-web.md`

## Como ler isto

Cada item abaixo é uma exigência de interface que **já tem critério escrito** na issue dona. O
`[ ]` só vira `[x]` com a evidência colada ao lado (saída de comando com data, ou captura da tela
com o passo que a produziu) — a mesma regra do `AGENTS.md`: “funciona” não é critério.

O ambiente desta rodada é **offline e sem navegador**: o que depende de `make up` (Docker Compose,
rede, DevTools) fica pendente por definição; o que é estático (`grep`) já foi executado e está
datado.

Comandos usados abaixo, a partir da raiz do monorepo:

```bash
make up                          # Docker Compose: nginx em :8080, API em :8000
pnpm --dir frontend build        # tsc + vite build
pnpm --dir frontend test         # Vitest (chega com a #28)
```

## Checklist

- [x] **1. A ordem renderizada é a ordem que a API devolveu** — nenhum `.sort(` no navegador
  (regra 1: o ranking é do servidor). Dono: **#25**.
  *Como provar:* `grep -nE '\.sort\(' frontend/src/pages/ResultsPage.tsx` deve sair **vazio** e
  a tela deve listar `rank` 1..n na ordem de `results`.
  *Evidência (2026-11-17):*
  ```
  $ grep -n sort frontend/src/pages/ResultsPage.tsx
  (sem match — exit 1)
  ```
  Reconferir antes do merge: `ResultsPage.tsx` está em edição pela #25/#27 nesta mesma rodada.

- [ ] **2. Toda a interface em inglês** — rótulos, mensagens de erro, estados vazios e `title`s.
  Donos: **#25–#28** (`AGENTS.md`, regra 6: interface em inglês, documentação em português).
  *Como provar:* `make up` e abrir as três telas (`/`, `/results?search=<id>`, `/skills/<id>`);
  nenhuma string renderizada em português. Apoio estático:
  `grep -rnE 'ç|ã|õ|á|é|í|ó|ú' frontend/src` revisado linha a linha (só comentário em português é
  aceitável; o texto que chega ao `DOM` não).

- [ ] **3. Foco visível, ordem de tabulação e skip link** (§6.6). Dono: **#27**.
  *Como provar:* `make up`; `Tab` a partir do topo até a busca (ordem previsível), `Enter` no
  submit e foco no **primeiro resultado**; contorno `:focus-visible` de **≥ 2 px** visível em cada
  controle; skip link “Skip to results” como primeiro elemento focável; `aria-live="polite"` na
  região de resultados e `role="status"`/`role="alert"` nos estados.
  *Estado hoje:* `grep -rn focus-visible frontend/src` sai **vazio** (só `aria-live` em
  `CopyText.tsx:90` e `role="status"`/`role="alert"` em `components/States.tsx:11,27,47`).

- [ ] **4. Erro visível com `request_id`, e o 429 de limite de uso** (§5.5, US-11). Dono: **#27**,
  pareia com esta issue **#13**.
  *Como provar:* `make up`; `curl` que force erro (ex.: `category` inexistente) e conferir a
  mensagem com o `request_id`; depois **11 buscas no mesmo minuto** (o backend agora responde
  `429 RATE_LIMITED` — provado por `pnpm --dir backend exec jest --config test/jest-e2e.json
  --runInBand throttle`, 4/4) e conferir na tela “Too many searches — try again in {n} seconds”
  **com o resultado anterior ainda visível**.
  *Estado hoje:* o mapa de código→mensagem já existe (`frontend/src/api.ts:46`) **e** a contagem de
  segundos também — `RATE_LIMITED` concatena `" Try again in {n} seconds."` quando
  `retryAfterSeconds > 0`, alimentado por `error.retry_after_seconds` (`api.ts:59-66,190`), que a
  #13 passou a garantir. O que falta na #27 é a **copy exata da US** e o "resultado anterior ainda
  visível".

- [ ] **5. Estado vazio acionável** (nenhuma tela em branco). Donos: **#25/#27**.
  *Como provar:* `make up` e uma busca que não retorne nada; a tela mostra as **três ações**
  (remover o filtro de categoria, simplificar a descrição, ver exemplos) e não some sem explicação
  (`AGENTS.md`, regra 7).

- [ ] **6. `n/a` para todo dado ausente, nunca `0`** (regra 3). Dono: **#26**, com prova automatizada
  na **#28**.
  *Como provar:* `make up` e abrir uma skill com `installs: null` / sem `SKILL.md`; cada campo
  nulo sai como `n/a`. Apoio estático: `grep -n 'n/a' frontend/src/pages/DetailPage.tsx` — hoje
  `DetailPage.tsx:15,93` e `ResultsPage.tsx:21,30` já traduzem `null` em `n/a`; falta a conferência
  na tela e o caso de teste (`results: [] → vazio`, `degraded: true → faixa`, `null → n/a`,
  `429 → mensagem`, erro com `request_id`) de `pnpm --dir frontend test`.

## O que fecha esta checklist

1. `make up` com as três telas exercitadas (itens 2–6) e captura/`curl` de cada uma no PR da #25–#28.
2. `pnpm --dir frontend test` verde na #28, cobrindo os cinco casos de estado.
3. Reexecutar o item 1 depois que a #25/#27 pararem de editar `frontend/src`.
