# Atalhos do monorepo — a fonte de verdade dos comandos (ver AGENTS.md).
# Uso: `make bootstrap` uma vez (gera o lock), `make up` (profile dev),
# `make PROFILE=prod up`.

SHELL := /bin/sh
COMPOSE := docker compose
PNPM := pnpm --dir backend
PROFILE ?= dev
# Cada profile tem o seu serviço de API, com o `build.target` correspondente.
API_SERVICE := $(if $(filter prod,$(PROFILE)),api,api-dev)
API_RUN := $(COMPOSE) --profile $(PROFILE) run --rm $(API_SERVICE)

.PHONY: bootstrap up down logs migrate seed test test-web lint config help \
        preflight lockfile openapi openapi-check

help:
	@echo "alvos: bootstrap | up | down | logs | migrate | seed | test | test-web | lint | config | openapi | openapi-check"
	@echo "  bootstrap  gera pnpm-lock.yaml (exige Node 22 nativo no WSL e rede)"
	@echo "  up         sobe postgres + API + web no profile $(PROFILE)"
	@echo "  test-web   roda a suíte do frontend (Vitest + Testing Library + MSW)"
	@echo "  openapi    regenera openapi.yaml a partir dos decorators do backend"
	@echo "  openapi-check  falha quando openapi.yaml diverge do documento gerado"

# Falha cedo, com instrução, quando o Node do WSL não serve. Sem isso o erro que
# aparece é `pnpm: exec: node: not found` — que não diz o que fazer.
preflight:
	@command -v node >/dev/null 2>&1 || { \
	  echo "ERRO: 'node' não existe no Ubuntu. Rode: bash scripts/setup-node-wsl.sh"; exit 1; }
	@case "$$(command -v node)" in \
	  /mnt/*) echo "ERRO: o 'node' resolvido é o do Windows ($$(command -v node))."; \
	          echo "      Rode: bash scripts/setup-node-wsl.sh"; exit 1 ;; \
	esac
	@case "$$(command -v pnpm 2>/dev/null)" in \
	  "") echo "ERRO: 'pnpm' ausente no Ubuntu. Rode: bash scripts/setup-node-wsl.sh"; exit 1 ;; \
	  /mnt/*) echo "ERRO: o 'pnpm' resolvido é o shim do Windows ($$(command -v pnpm))."; \
	          echo "      Rode: bash scripts/setup-node-wsl.sh"; exit 1 ;; \
	esac

# A imagem instala com `--frozen-lockfile`: sem o lock o build falha com um erro
# de cache key que não explica nada. Aqui a mensagem é explícita.
lockfile:
	@test -f backend/pnpm-lock.yaml || { \
	  echo "ERRO: backend/pnpm-lock.yaml não existe."; \
	  echo "      Rode 'make bootstrap' (precisa de rede) e commite o arquivo."; exit 1; }
	@test -f frontend/pnpm-lock.yaml || { \
	  echo "ERRO: frontend/pnpm-lock.yaml não existe."; \
	  echo "      Rode 'make bootstrap' (precisa de rede) e commite o arquivo."; exit 1; }

# Gera os dois lockfiles (exige rede). É pré-requisito do build e do lint do
# frontend — que também roda `tsc`/`eslint` contra `node_modules`.
bootstrap: preflight
	$(PNPM) install
	pnpm --dir frontend install

# `up` não exige Node/pnpm no host: os comandos rodam dentro dos containers. Só o
# lockfile é pré-requisito, porque a imagem instala com `--frozen-lockfile`.
up: lockfile
	$(COMPOSE) --profile $(PROFILE) up -d --build

down:
	$(COMPOSE) --profile $(PROFILE) down --remove-orphans

logs:
	$(COMPOSE) --profile $(PROFILE) logs -f --tail=100

# `migrate deploy` é idempotente: aplica só o que ainda não está em
# `_prisma_migrations`, então pode rodar em todo deploy. Sem `--no-deps`: o `run`
# sobe o `postgres` e espera o healthcheck antes de aplicar a migration.
migrate: lockfile
	$(API_RUN) pnpm prisma:deploy

# TODO(F2.3): virar `pnpm ingest:fixture` quando a ingestão existir.
seed:
	@echo "seed: pendente da F2.3 (ingestão pela fixture)"

test: preflight
	$(PNPM) test
	$(PNPM) test:e2e

# Suíte de UI do frontend (Vitest + jsdom + Testing Library + MSW). Fica **fora** de `test`
# de propósito: o gate do backend continua rápido e a F4 orquestra `test` + `test-web`.
test-web: preflight
	pnpm --dir frontend test

lint: preflight
	$(PNPM) lint
	$(PNPM) typecheck
	@echo "frontend: exige node_modules (sem rede nesta máquina)"
	pnpm --dir frontend run lint

# `openapi.yaml` é gerado, nunca editado à mão (AGENTS.md §Documentação da API).
# `preflight` como nos demais alvos: sem o Node do WSL o erro que aparece é
# `pnpm: exec: node: not found`, que não diz o que fazer.
openapi: preflight
	$(PNPM) openapi:generate

# Gate do contrato: o artefato versionado e o documento dos decorators não podem
# divergir. `git ls-files --error-unmatch` vem antes da geração de propósito: sem
# ele o alvo ficaria verde com `openapi.yaml` fora do versionamento (arquivo
# ignorado ou nunca adicionado), que é justamente o caso em que o gate mente.
# O `git diff HEAD` cobre staged e unstaged: sem isso, um `git add openapi.yaml`
# com o conteúdo novo deixaria o alvo verde antes do commit — a mesma classe de
# verde falso que o `ls-files` acima existe para impedir.
openapi-check: preflight
	git ls-files --error-unmatch -- openapi.yaml >/dev/null
	$(PNPM) openapi:generate
	git diff --exit-code HEAD -- openapi.yaml

# Sem `.env` o compose usa o default de desenvolvimento (`skillsdev`); em
# `ENV=prod` o backend recusa esse default no boot.
config:
	$(COMPOSE) config -q
	@echo "compose OK"
