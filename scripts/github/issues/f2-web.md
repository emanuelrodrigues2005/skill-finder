# F2 — Aplicação (frontend)

<!--ISSUE:feat(web): cliente /api/v1 tipado e validado contra openapi.yaml-->
## O que entrega

O cliente único da API em `frontend/src/api.ts` ligado ao contrato real: tipos derivados de
`openapi.yaml`, **zero mock** (`MOCK_*`, `loadMock*` removidos), envelope de erro traduzido por
`error.code` (nunca por texto) e `request_id` preservado no `ApiError`. Faz a troca **mínima** das 3
telas de `loadMock*` para `getCategories`/`searchSkills`/`getSkill`; o polimento de cada tela é das
issues seguintes, que **não tocam** em `api.ts`.

## Critérios de aceitação

- [ ] `frontend/src/api/types.gen.ts` gerado de `openapi.yaml` e commitado; geração idempotente
- [ ] `grep -c 'MOCK_\|loadMock' frontend/src/api.ts` = 0
- [ ] `ApiError` expõe `status`, `code`, `requestId` e `retryAfterSeconds`
- [ ] mapa código→mensagem em inglês cobre `VALIDATION_ERROR`, `UNKNOWN_CATEGORY`, `NOT_FOUND`, `HISTORY_EXPIRED`, `RATE_LIMITED`, `SOURCE_UNAVAILABLE`, `LLM_BAD_RESPONSE`, `INTERNAL`; código desconhecido cai em mensagem genérica
- [ ] toda chamada usa `AbortController` com timeout; `baseURL` relativo `/api/v1`
- [ ] nenhuma chave no bundle: `grep -rn 'LLM_API_KEY\|sk-' frontend/src frontend/dist` vazio
- [ ] `tsc --noEmit`, `build` e `eslint .` verdes

## Verificação

```bash
pnpm --dir frontend gen:types && git diff --exit-code frontend/src/api/types.gen.ts
grep -c 'MOCK_\|loadMock' frontend/src/api.ts          # 0
pnpm --dir frontend exec tsc --noEmit && pnpm --dir frontend build
pnpm --dir frontend exec eslint .
grep -rn 'LLM_API_KEY\|sk-' frontend/src frontend/dist   # vazio
```

## Dependências

- Depois do contrato congelado e de `openapi.yaml` commitado.

## Pareia com

**Pareia com:** feat(api): congelar contrato OpenAPI v0 com 8 endpoints

## Referência

- `docs/app/02-arquitetura.md` §5 e §5.5 · `docs/app/03-plano-app.md` §3/F2.1 e §3/F2.7 · `docs/app/01-spec-produto.md` US-11

<!--ISSUE:feat(web): tela de busca com categoria e validação 3–500-->
## O que entrega

A tela **Search** operando contra o contrato: `textarea` com contador e faixa 3–500, seletor de
categoria **populado por `GET /api/v1/categories`** (nenhuma lista fixa), botão desabilitado fora da
faixa, envio por `POST /api/v1/search` e navegação para o **permalink** `/results?search=<id>`.
Erro do envio aparece no formulário com `request_id`, sem apagar o que o usuário digitou.

## Critérios de aceitação

- [ ] contador `n/500` a cada tecla; `maxLength=500` e guarda no submit
- [ ] `<select>` alimentado por `GET /api/v1/categories`; `grep -rn 'MOCK_CATEGORIES' frontend/src` vazio
- [ ] `422 UNKNOWN_CATEGORY` mostra mensagem do código e o `request_id`; formulário continua utilizável
- [ ] `503 SOURCE_UNAVAILABLE` mostra "Data source unavailable — try again later" e **não** navega
- [ ] submit válido navega para `/results?search=<id>`; `query` e `category` permanecem ao voltar
- [ ] permalink visível e copiável (mesma origem), estável em reload
- [ ] `tsc --noEmit`, `build` e `eslint` verdes

## Verificação

```bash
pnpm --dir frontend exec tsc --noEmit && pnpm --dir frontend build && pnpm --dir frontend exec eslint .
grep -rn 'MOCK_CATEGORIES' frontend/src    # vazio
make up   # submeter busca, conferir /results?search=... e reload
```

## Dependências

- Depois do cliente tipado. Precisa de `GET /categories` e `POST /search` no ar.

## Pareia com

**Pareia com:** feat(api): endpoints de busca, permalink e detalhe da skill

## Referência

- `docs/app/01-spec-produto.md` US-01, US-02, US-03, US-09, US-11 · `docs/app/02-arquitetura.md` §5.1–§5.5

<!--ISSUE:feat(web): resultados com score, selo e aviso de degradação-->
## O que entrega

A tela **Results** consumindo `POST /api/v1/search` (e `GET /api/v1/searches/{id}` no reload):
lista **na ordem que a API devolveu**, `rank` e `score` visíveis, selo de `evidence_completeness`,
1–3 *bullets* de razão, `flags` quando presentes, faixa de `degraded` com motivo e idade do catálogo,
e a **recomendação única** destacada. Nenhum cálculo de ordenação no navegador.

## Critérios de aceitação

- [ ] ordem renderizada = ordem recebida; `grep -n '\.sort(' frontend/src/pages/ResultsPage.tsx` vazio
- [ ] `rank` e `score` (≥ 4 casas) visíveis; `score` e `score_breakdown` nunca recalculados no cliente
- [ ] selo de `evidence_completeness` derivado de `missing_fields`/`penalty_factor`
- [ ] 1–3 *bullets* de razão por item; `flags` listadas quando não vazias
- [ ] `data.degraded = true` → faixa com `degraded_reason` e, em `source_stale`, a idade em horas
- [ ] `recommendation` destacada e igual a `results[0].skill.skill_id`
- [ ] reload de `/results?search=<id>` usa `GET /api/v1/searches/{id}`; `410 HISTORY_EXPIRED` mostra mensagem e link para nova busca
- [ ] `tsc --noEmit`, `build` e `eslint` verdes

## Verificação

```bash
pnpm --dir frontend exec tsc --noEmit && pnpm --dir frontend build && pnpm --dir frontend exec eslint .
grep -n '\.sort(' frontend/src/pages/ResultsPage.tsx    # vazio
make up   # buscar, conferir ordem/score/selo/degraded e recarregar o permalink
```

## Dependências

- Depois do cliente tipado. Backend: ranking e endpoints de busca no ar.

## Pareia com

**Pareia com:** feat(ranking): score determinístico com desempate estável

## Referência

- `docs/app/01-spec-produto.md` US-04, US-05, US-07, US-08 · `docs/app/02-arquitetura.md` §5.3 e §5.5

<!--ISSUE:feat(web): detalhe da skill com SKILL.md seguro e n/a-->
## O que entrega

A tela **Detail** por `GET /api/v1/skills/{skill_id}`: metadados com **`n/a` para todo `null`**
(estrelas, instalações, vulnerabilidades — que **não existem na fonte**, ver `docs/app/amostras/`),
repositório e resumo, data de referência do dado, e o `SKILL.md` renderizado em `react-markdown` com
**HTML desabilitado** (`skipHtml`, sem `rehype-raw`), links com `rel="noopener noreferrer"`.

## Critérios de aceitação

- [ ] todo valor `null` exibe `n/a`; nenhum `0` inventado
- [ ] `grep -rn 'rehype-raw\|dangerouslySetInnerHTML' frontend/src frontend/package.json` vazio
- [ ] todo link sai com `rel="noopener noreferrer"`; `href` não-`http(s)` não é clicável
- [ ] documento ausente → "No full description available for this skill" + `n/a`
- [ ] exibe `fetched_at` ou `catalog_snapshot` em formato legível
- [ ] `404 NOT_FOUND` → "Skill not found" com `request_id`; `422`/`500` caem no estado de erro
- [ ] `tsc --noEmit`, `build` e `eslint` verdes

## Verificação

```bash
pnpm --dir frontend exec tsc --noEmit && pnpm --dir frontend build && pnpm --dir frontend exec eslint .
grep -rn 'dangerouslySetInnerHTML\|rehype-raw' frontend/src frontend/package.json   # vazio
make up   # abrir skill com installs null (n/a) e skill sem SKILL.md
```

## Dependências

- Depois do cliente tipado. Backend: `GET /skills/{skill_id}` no ar.

## Pareia com

**Pareia com:** feat(api): endpoints de busca, permalink e detalhe da skill

## Referência

- `docs/app/01-spec-produto.md` US-06 · `docs/app/02-arquitetura.md` §5.4 e §5.5 · `docs/app/amostras/README.md`

<!--ISSUE:feat(web): estados de erro, foco visível e aria-live-->
## O que entrega

Os **quatro estados por tela** (loading, empty, error, success) sem nenhuma tela em branco, com a
acessibilidade do §6.6: foco visível, ordem de tabulação previsível, skip link, `aria-live` na região
de resultado, `role="status"`/`role="alert"`, texto do usuário sempre como texto puro, layout até
**360 px** e as mensagens de limite de uso e de vazio acionável.

## Critérios de aceitação

- [ ] loading/empty/error/success presentes em Search, Results e Detail
- [ ] `aria-live="polite"` na região de resultados e `role="status"`/`role="alert"` nos estados
- [ ] skip link "Skip to results"; `:focus-visible` com contorno ≥ 2 px
- [ ] `429 RATE_LIMITED` → "Too many searches — try again in {n} seconds" e o resultado anterior continua visível
- [ ] estado vazio com as três ações (remover categoria, simplificar descrição, exemplos)
- [ ] `grep -rn 'dangerouslySetInnerHTML' frontend/src` vazio
- [ ] 360 px sem rolagem horizontal; contraste ≥ 4,5:1 nos metadados
- [ ] checklist datado em `docs/evidencias/f2-ui.md`

## Verificação

```bash
pnpm --dir frontend build && pnpm --dir frontend exec eslint .
grep -rn 'dangerouslySetInnerHTML' frontend/src     # vazio
make up   # teclado: tab até Search, Enter, foco no resultado; DevTools em 360 px; simular 429
```

## Dependências

- Roda em paralelo com as telas, **sem** mudar a assinatura de props dos componentes de estado.

## Pareia com

**Pareia com:** fix(api): bloquear prompt injection e aplicar limites de uso

## Referência

- `docs/app/01-spec-produto.md` §6.6 · US-03 AC4, US-07 AC2, US-08, US-11

<!--ISSUE:test(web): Vitest e Testing Library com contrato mockado-->
## O que entrega

A suíte de UI do frontend: **Vitest + Testing Library + jsdom + MSW**, handlers derivados do contrato,
um teste por tela e um teste do cliente para o envelope de erro. **Nenhum teste abre socket**:
`onUnhandledRequest: 'error'`.

## Critérios de aceitação

- [ ] `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom` e `msw` em `devDependencies`; `pnpm --dir frontend test` = `vitest run`
- [ ] 3 testes de tela + 1 teste de cliente com handlers MSW e fixture de contrato
- [ ] `onUnhandledRequest: 'error'`; nenhuma requisição real
- [ ] os testes falham sem a implementação (provado com o arquivo da tela revertido)
- [ ] casos: `results: []` → vazio; `degraded: true` → faixa; `null` → `n/a`; `429` → mensagem; erro com `request_id`
- [ ] `pnpm --dir frontend test` verde com a máquina offline
- [ ] `make test-web` criado para a F4 consumir

## Verificação

```bash
pnpm --dir frontend test
pnpm --dir frontend test -- --coverage
grep -rn 'localhost:8080\|fetch(' frontend/src --include=*.test.tsx   # vazio
make test-web
```

## Dependências

- Depois das telas (os testes asseram o markup final). Instalação exige rede.

## Pareia com

**Pareia com:** test(api): três níveis de teste e suíte offline no CI

## Referência

- `docs/app/03-plano-app.md` §3/F2.8 · `AGENTS.md` regra 5 (nenhum teste abre socket)

<!--ISSUE:docs(api): Swagger gerado, Scalar em /docs e openapi.yaml no CI-->
## O que entrega

O contrato como **artefato vivo e navegável**: decoradores `@nestjs/swagger` nos 8 endpoints,
`openapi.yaml` na raiz gerado por `pnpm --dir backend openapi:generate` e **commitado**, **Scalar**
servindo `/docs` e o JSON cru em `/docs-json`.

Decisão de exposição: `/docs` e `/docs-json` **só fora de produção** (`!config.isProd`). Camadas
independentes: o nginx da SPA só proxia `/api/` e, no profile `prod`, a API publica em `127.0.0.1`.

## Critérios de aceitação

- [ ] `@scalar/nestjs-api-reference` em `devDependencies`, importado dinamicamente dentro do bloco `!isProd`
- [ ] `GET /docs` = 200 em dev com a UI do Scalar; `GET /docs-json` com **8 paths**
- [ ] com `ENV=prod`, `/docs` e `/docs-json` respondem **404** e o pacote não existe na imagem de produção
- [ ] `pnpm --dir backend openapi:generate` idempotente: `git diff --exit-code openapi.yaml`
- [ ] `openapi.yaml` commitado com `info.version`, descrição por operação e `@ApiResponse` em cada 4xx/5xx
- [ ] nenhum segredo no artefato: `grep -ci 'api_key\|authorization' openapi.yaml` = 0
- [ ] alvo `make openapi-check` (gera + `git diff --exit-code`) para o CI da F4 chamar
- [ ] nginx da SPA continua sem `location /docs`
- [ ] `typecheck`, `test` e `eslint` verdes

## Verificação

```bash
pnpm --dir backend openapi:generate && git diff --exit-code openapi.yaml
make openapi-check
curl -fsS -o /dev/null -w '%{http_code}\n' localhost:8080/docs          # 200 (dev)
curl -sS localhost:8080/docs-json | jq '.paths | keys | length'          # 10
grep -n 'docs' frontend/nginx.conf                                        # nada de /docs
grep -ci 'api_key\|authorization' openapi.yaml                            # 0
```

## Dependências

- Depois do contrato v0 (mesmo `openapi.yaml` e mesmo `main.ts`: sequencial).

## Pareia com

**Pareia com:** feat(api): congelar contrato OpenAPI v0 com 8 endpoints

## Referência

- `docs/app/02-arquitetura.md` §5, §5.5 e ADR-007 · `backend/src/main.ts`, `backend/scripts/generate-openapi.ts`
