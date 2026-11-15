# Skill Finder — Projeto 2 (Computação em Nuvem · UFRPE)

Aplicação que ajuda a encontrar **skills de agentes** no site [skills.sh](https://skills.sh).
O usuário descreve, em linguagem natural, para que precisa da skill e — opcionalmente — escolhe
uma categoria. A aplicação interpreta o pedido com uma LLM, consulta o catálogo do skills.sh e
devolve uma lista **ordenada e explicada**, priorizando boas avaliações, poucas vulnerabilidades
e muitas instalações.

Este repositório é o entregável do Projeto Integrador: aplicação + infraestrutura em Terraform +
pipeline CI/CD + observabilidade, na arquitetura definida em [`docs/01`](docs/01-analise-requisitos-e-arquitetura.md).

## Estado atual

| Parte | Estado |
| --- | --- |
| Documentação (edital, arquitetura, planos) | pronto |
| Sandbox AWS Academy validado (conta, região, key pair, ECR, S3) | pronto |
| Esqueleto `backend/` + `frontend/` + `compose.yaml` | em construção |
| Fonte de dados do skills.sh | **a descobrir** — ver `docs/app/03-plano-app.md` §2 (F2.0) |
| Terraform, CI/CD, observabilidade | planejado (F3–F5) |

## Como rodar

Requisitos: Docker Desktop com **Compose ≥ 2.24** (o `compose.yaml` usa `env_file.required` e
`depends_on.required`) e — para desenvolvimento sem Docker — **Node 22 + pnpm** no WSL:

```bash
bash scripts/setup-node-wsl.sh    # Node 22 nativo + pnpm 9.15.4 (confira com: command -v node)
```

Se `command -v node` responder algo em `/mnt/c/...`, você está usando o Node do Windows dentro do
Ubuntu e o pnpm vai falhar com `exec: node: not found` — é exatamente o que o script corrige.
PostgreSQL 16 sobe pelo próprio compose.

```bash
cp .env.example .env    # preencha POSTGRES_PASSWORD (o compose recusa subir sem ela)
make bootstrap          # pnpm install: gera e fixa o pnpm-lock.yaml (commite-o)
make config             # valida o compose
make up                 # sobe postgres + api + web (profile dev)
make logs
make down
```

O `pnpm-lock.yaml` entra no repositório no primeiro `make bootstrap`; a imagem de produção
usa `--frozen-lockfile` e falha se ele não existir — de propósito, para o build nunca resolver
dependências novas sem auditoria.

A API expõe `/healthz`, `/readyz` e `/metrics` em `http://localhost:8080` (bind em
`127.0.0.1` — o nginx é a borda). A interface fica em `http://localhost:8081`.

## Estrutura

```
backend/          API NestJS 11 + TypeScript: rotas, ranking, catálogo, integração com a LLM
frontend/         SPA React + Vite + TypeScript, servida por Nginx
docs/             edital transcrito, requisitos, arquitetura, planos, amostras
docs/app/         spec do produto, arquitetura do software, plano da F2
scripts/          provisionamento e verificações (toolchain, sandbox AWS, descoberta de dados)
compose.yaml      Postgres + api + web
Makefile          atalhos de desenvolvimento
```

## Documentação

Comece por [`AGENTS.md`](AGENTS.md) se você é um agente; por [`docs/README.md`](docs/README.md)
se você é humano. Os dois documentos centrais do produto são
[`docs/app/01-spec-produto.md`](docs/app/01-spec-produto.md) (o que ele faz e como ranqueia) e
[`docs/app/02-arquitetura.md`](docs/app/02-arquitetura.md) (como é construído).

## Segurança

A chave da LLM existe apenas no backend, em `.env` (ignorado pelo Git). Nenhum segredo entra no
repositório, na imagem ou no bundle do frontend. O `.gitignore` cobre `.env`, chaves privadas,
estado do Terraform e artefatos de build.

## Licença

Trabalho acadêmico — sem licença definida.
