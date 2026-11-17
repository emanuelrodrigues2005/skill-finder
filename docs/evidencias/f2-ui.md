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

- [x] **3. Foco visível, ordem de tabulação e skip link** (§6.6). Dono: **#27**.
  *Como provar:* `make up`; `Tab` a partir do topo até a busca (ordem previsível), `Enter` no
  submit e foco no **primeiro resultado**; contorno `:focus-visible` de **≥ 2 px** visível em cada
  controle; skip link “Skip to results” como primeiro elemento focável; `aria-live="polite"` na
  região de resultados e `role="status"`/`role="alert"` nos estados.
  *Evidência automatizada (2026-11-17, issue #28):* `frontend/src/test/a11y.test.tsx` — skip link é
  o primeiro focável e aponta para `#results` (`main`), ordem de tabulação `a → a → textarea →
  select → button`, `:focus-visible` com `outline: 3px solid` lido do CSS injetado, `.skip-link`
  fora da tela até receber foco, `aria-live="polite"` no `list` de resultados e `role="status"`
  (loading/vazio) / `role="alert"` (erro/429) nos estados. `pnpm --dir frontend test` verde.

- [ ] **4. Erro visível com `request_id`, e o 429 de limite de uso** (§5.5, US-11). Dono: **#27**,
  pareia com esta issue **#13**. **Parcial: a copy exata da US continua fora.**
  *Como provar:* `make up`; `curl` que force erro (ex.: `category` inexistente) e conferir a
  mensagem com o `request_id`; depois **11 buscas no mesmo minuto** (o backend agora responde
  `429 RATE_LIMITED` — provado por `pnpm --dir backend exec jest --config test/jest-e2e.json
  --runInBand throttle`, 4/4) e conferir na tela “Too many searches — try again in {n} seconds”
  **com o resultado anterior ainda visível**.
  *Estado hoje (2026-11-17):* o **“resultado anterior ainda visível” está feito** — um 429 no
  replay do permalink não troca mais a lista por um erro: o aviso entra acima e a lista fica
  (`ResultsPage.tsx`, prova em `frontend/src/test/screens/states.test.tsx`, caso “a 429 keeps the
  previous result on screen”). A **copy exata da US** é a única parte aberta: a frase é do mapa
  `error.code → mensagem` em `frontend/src/api.ts:46` (`"Too many requests."` +
  `" Try again in {n} seconds."`), arquivo de outro dono — e o teste da #29 fixa essa frase
  (`ResultsPage.test.tsx`, “shows the rate-limit message with the retry delay in seconds”). Trocar
  a copy exige mudar `api.ts` **e** esse teste na mesma alteração.

- [x] **5. Estado vazio acionável** (nenhuma tela em branco). Donos: **#25/#27**.
  *Como provar:* `make up` e uma busca que não retorne nada; a tela mostra as **três ações**
  (remover o filtro de categoria, simplificar a descrição, ver exemplos) e não some sem explicação
  (`AGENTS.md`, regra 7).
  *Evidência automatizada (2026-11-17, issue #28):* `frontend/src/pages/ResultsPage.tsx`
  (`EmptyActions`) renderiza as três saídas no estado vazio, e cada uma **funciona**:
  “Remove the category filter” volta para `/` com `state.clearCategory` e o rascunho perde a
  categoria; “Simplify the description” preserva o texto; os dois exemplos preenchem a consulta.
  Prova em `frontend/src/test/screens/states.test.tsx` (3 casos), `pnpm --dir frontend test` verde.

- [x] **6. `n/a` para todo dado ausente, nunca `0`** (regra 3). Dono: **#26**, com prova automatizada
  na **#28**.
  *Como provar:* `make up` e abrir uma skill com `installs: null` / sem `SKILL.md`; cada campo
  nulo sai como `n/a`. Apoio estático: `grep -n 'n/a' frontend/src/pages/DetailPage.tsx` — hoje
  `DetailPage.tsx:15,93` e `ResultsPage.tsx:21,30` já traduzem `null` em `n/a`.
  *Evidência automatizada (2026-11-17, issue #28):* os cinco casos de estado rodam em
  `pnpm --dir frontend test` (48 testes, verde): `results: [] → vazio`, `degraded: true → faixa`,
  `null → n/a` (`ResultsPage.test.tsx`, “renders null catalog fields as n/a instead of zero”),
  `429 → mensagem` e erro com `request_id` (`ResultsPage.test.tsx`, “keeps the request id of a
  replay that failed”).

## O que fecha esta checklist

1. `make up` com as três telas exercitadas (itens 2–6) e captura/`curl` de cada uma no PR da #25–#28.
2. `pnpm --dir frontend test` verde na #28, cobrindo os cinco casos de estado.
3. Reexecutar o item 1 depois que a #25/#27 pararem de editar `frontend/src`.

## Rodada da issue #28 — 2026-11-17

Escopo: `frontend/src/components/States.tsx` (intocado — os `role` já estavam lá),
`frontend/src/App.tsx`, as três telas e a suíte. Ambiente: WSL, **sem navegador e sem Docker**;
só o que é automatizável foi provado aqui — teclado real, DevTools em 360 px e `make up` continuam
pendentes por definição.

```bash
pnpm --dir frontend test            # 8 arquivos, 48 testes — EXIT 0
pnpm --dir frontend typecheck       # tsc --noEmit — EXIT 0
pnpm --dir frontend lint            # eslint . — EXIT 0
pnpm --dir frontend build           # tsc --noEmit && vite build — EXIT 0
pnpm --dir frontend check:contract  # 13 grupos, 10 endpoints, 24 schemas — EXIT 0
grep -rn 'dangerouslySetInnerHTML' frontend/src   # vazio (exit 1)
```

| AC da #28 | Onde foi entregue | Prova |
| --- | --- | --- |
| loading/empty/error/success em Search, Results e Detail | `App.tsx`, `States.tsx` (já existia), `ResultsPage.tsx`, `SearchPage.tsx` | `src/test/screens/states.test.tsx` (9 casos) + os 6 da #29 por tela |
| `aria-live="polite"` na região de resultados, `role` nos estados | `ResultsPage.tsx` (`<ol aria-live>`), `States.tsx` (`role="status"`/`"alert"`) | `src/test/a11y.test.tsx` — 3 casos de região viva/role |
| skip link “Skip to results”; `:focus-visible` ≥ 2 px | `App.tsx` (link + `GLOBAL_STYLES`) | `src/test/a11y.test.tsx` — primeiro focável, `href="#results"`, `outline: 3px solid` lido do CSS |
| 429 mantém o resultado anterior | `ResultsPage.tsx` (`rateLimitNotice`) | `states.test.tsx` — “a 429 keeps the previous result on screen”; vermelho sem o `if` (1 failed), verde com ele |
| vazio com as três ações | `ResultsPage.tsx` (`EmptyActions`) + `SearchPage.tsx` (`clearCategory`/`exampleQuery`) | `states.test.tsx` — 3 casos, incluindo a categoria removida no rascunho |
| `grep dangerouslySetInnerHTML` vazio | — | comando acima, sem match |
| 360 px sem rolagem horizontal | nenhuma largura fixa em `px` > 360 | `a11y.test.tsx` — guarda de largura; **layout real não é observável em jsdom** |
| contraste ≥ 4,5:1 nos metadados | paleta já existente | `a11y.test.tsx` calcula a razão WCAG de toda cor de texto renderizada (mínimo medido: 5,0:1) |
| texto do usuário como texto puro | — | `a11y.test.tsx` — `skill_md_excerpt` e `recommendation` com `<b>`/`<img>`/`<script>` saem como caracteres |

**Correção de ambiente que veio junto:** o shim `frontend/src/test/fetchBase.ts` agora entrega ao
`undici` um `RequestInit` que ele aceita. Sem isso, o `AbortSignal` do jsdom era recusado
(`TypeError: RequestInit: Expected signal … to be an instance of AbortSignal`) em **toda** chamada
de `src/api.ts`, e 13 dos 26 testes da #29 falhavam antes de qualquer mudança desta issue — era
ambiente, não comportamento de tela. Prova: `src/test/fetchBase.test.ts` (3 casos).

**Aberto:** a copy exata “Too many searches — try again in {n} seconds” (US-11 AC2) continua fora,
porque mora em `frontend/src/api.ts` (outro dono) e o teste da #29 fixa a frase atual — ver item 4.

