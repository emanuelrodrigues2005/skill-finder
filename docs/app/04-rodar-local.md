# Rodar o projeto localmente

Roteiro verificado em 2026-11-17, do zero até a busca responder com resultados.
Tudo roda em **WSL/Ubuntu** com Docker. Não precisa de `.env` para o profile de dev.

## Requisitos

| Ferramenta | Versão testada |
| --- | --- |
| Node | 24.22.3 (o `engines` pede ≥ 22) |
| pnpm | 12.21.0 (o `packageManager` fixa) |
| Docker + compose | 29.1.3 / 2.40.3 |
| make | 4.4.1 |

Confira o ambiente com `bash scripts/dev/env-report.sh` (mostra versões, se o `.env`
existe, o que está escutando nas portas e quais variáveis o compose exige).

## Caminho rápido — tudo em Docker

```bash
make up        # postgres + API (api-dev, hot reload) + web (nginx servindo o build)
make seed      # popula o catálogo com a fixture congelada (25 skills)
```

Depois abra **http://localhost:8081** — é a SPA servida pelo nginx, que faz proxy de
`/api` para a API. A API sozinha fica em **http://localhost:8080** (healthz, readyz,
metrics e o Scalar em `/docs`).

> **Porta da API.** O compose publica em `127.0.0.1:${API_PORT:-8080}`. Se a 8080 do seu
> host estiver presa (o Docker Desktop às vezes deixa um proxy órfão — ver a tabela de
> problemas no fim), crie um `.env` com `API_PORT=8090`. A SPA **não** sente: o nginx fala
> com a API pela rede interna (`api:8000`), não pela porta publicada.

Conferir que está de pé:

```bash
make logs                  # logs dos três serviços
bash scripts/dev/status-local.sh   # containers + código HTTP de cada endpoint
bash scripts/dev/smoke-local.sh    # busca de verdade e o detalhe de uma skill
```

Derrubar:

```bash
make down                  # mantém o volume do Postgres
make down && docker volume rm cloud_postgres-data   # apaga os dados
```

## O que cada serviço é

| Serviço | Porta no host | Para que serve |
| --- | --- | --- |
| `postgres` | **nenhuma** (só na rede do compose) | banco; o seed e a migração rodam dentro da rede |
| `api-dev` | `127.0.0.1:8080` | NestJS com `start:dev`; `src/` e `prisma/` montados, então salvar arquivo reinicia |
| `web` | `8081` | nginx: serve o `dist/` e faz proxy de `/api` para `api:8000` |

O Postgres **não** publica porta no host de propósito: nada de fora alcança o banco.
Por isso `make migrate` e `make seed` rodam com `docker compose run` — a rede é a do
compose.

## Estado esperado da API

| Endpoint | Sem seed | Com seed |
| --- | --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` | idem |
| `GET /readyz` | `200` com `postgres: up` | idem |
| `GET /api/v1/categories` | `503 SOURCE_UNAVAILABLE` (`cache_empty`) | `200` — **lista vazia**: a fixture não traz categoria |
| `GET /api/v1/skills` | `200` com `data: []` | `200` com 25 itens |
| `POST /api/v1/search` | `503 SOURCE_UNAVAILABLE` | `200` com resultados |

O `503` sem seed é o comportamento correto (regra 7 do `AGENTS.md`): degradação
visível, nunca lista vazia sem explicação.

### Busca degradada é o esperado em dev

Sem `LLM_API_KEY`, a API sobe com `LLM_ENABLED=false` e toda busca volta
`data.degraded: true`, `degraded_reason: "llm_unavailable"` e a intenção vem do
fallback por palavras-chave. **Não é bug** — é o modo de dev/CI documentado.

Consequência prática: o fallback casa por palavra, então `"skills"` retorna 3
resultados e `"find skills for webapp testing"` pode retornar zero. Para ver
resultado, use termos que existam no catálogo (`skills`, `webapp`, `aws`, `clerk`).

## Dev com hot reload no frontend

O `vite.config.ts` aponta o proxy para `http://api:8000` — o nome do serviço no
compose. Rodando o Vite **fora** do compose, troque o `target` para
`http://localhost:8080` **ou** mantenha o `web` do compose e edite só o backend.

```bash
make up                     # postgres + api
pnpm --dir frontend install # uma vez
pnpm --dir frontend dev     # Vite em http://localhost:5173
```

⚠️ A porta **5173** costuma estar ocupada por um Vite antigo; o Vite então escolhe
5174. Confira com `bash scripts/dev/ports.sh`.

## Testes, sem subir nada

```bash
make test              # backend: unit + api (não precisa de Docker)
make test-web          # frontend: Vitest + jsdom + MSW (sem rede)
make lint              # eslint dos dois projetos
make openapi-check     # openapi.yaml sincronizado com os decorators
make test-integration  # precisa de Postgres: sobe um container próprio na 55432
make test-coverage     # cobertura ≥ 80% por diretório do domínio + JUnit
make offline-check     # roda unit+api sem rede, com canário que reprova o próprio verde
```

## Problemas que já apareceram

| Sintoma | Causa | Solução |
| --- | --- | --- |
| `groupadd: not found` no build do `web` | `nginx:alpine` é BusyBox; `groupadd`/`useradd` não existem | já corrigido: o Dockerfile usa `addgroup`/`adduser` |
| `pnpm seed` → `Command "seed" not found` | a imagem foi construída antes do script entrar no `package.json` | `docker compose --profile dev build api-dev` |
| `503 cache_empty` em toda busca | catálogo vazio | `make seed` |
| `request to registry.npmjs.org` falha no build | hiccup de rede do BuildKit | repetir `make up`; as camadas ficam em cache |
| porta 8080/8081 ocupada | stack anterior de pé | `make down` |
| `address already in use` na 8080 **mesmo após** `make down` | proxy órfão do Docker Desktop: o container da API morreu de forma anormal e o proxy ficou apontando para ele (responde 404 e o `down` não o libera) | `bash scripts/dev/who-holds.sh 8080` confirma; depois `API_PORT=8090` no `.env` (mais simples) ou reiniciar o Docker Desktop |
| API em `Exited (255)` e não volta | caiu, e o compose não consegue religar por conflito de porta | `bash scripts/dev/restart-clean.sh` |

## Modo produção (sem hot reload)

```bash
make PROFILE=prod up
```

Sobe `api` (target `runtime`, sem devDependencies, `ENV=prod`) e o `web`. Em prod o
`env.schema.ts` exige `DATABASE_URL`, `IP_HASH_SALT` e, com a LLM ligada,
`LLM_API_KEY` — copie `.env.example` para `.env` e preencha.
