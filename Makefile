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

.PHONY: bootstrap up down logs migrate seed test lint config

# Gera `pnpm-lock.yaml` (exige rede) e é pré-requisito do primeiro build: a imagem
# instala com `--frozen-lockfile` e falha alto sem o lock. Commite o arquivo.
bootstrap:
	$(PNPM) install

up:
	$(COMPOSE) --profile $(PROFILE) up -d --build

down:
	$(COMPOSE) --profile $(PROFILE) down --remove-orphans

logs:
	$(COMPOSE) --profile $(PROFILE) logs -f --tail=100

# `migrate deploy` é idempotente: aplica só o que ainda não está em
# `_prisma_migrations`, então pode rodar em todo deploy. Sem `--no-deps`: o `run`
# sobe o `postgres` e espera o healthcheck antes de aplicar a migration.
migrate:
	$(API_RUN) pnpm prisma:deploy

# TODO(F2.3): virar `pnpm ingest:fixture` quando a ingestão existir.
seed:
	@echo "seed: pendente da F2.3 (ingestão pela fixture)"

test:
	$(PNPM) test
	$(PNPM) test:e2e

lint:
	$(PNPM) lint
	$(PNPM) typecheck
	@echo "frontend: exige node_modules (sem rede nesta máquina)"
	pnpm --dir frontend run lint

# Exige `POSTGRES_PASSWORD` no `.env`: o compose falha na interpolação sem ela.
config:
	$(COMPOSE) config -q
	@echo "compose OK"
