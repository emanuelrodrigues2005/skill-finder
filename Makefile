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

# A borda do `dev` precisa do proxy `/api` (`frontend/nginx.dev.conf`); a de
# produção é estática e o default do compose já é essa. A escolha é do profile,
# aqui, e não do `.env`: variável de ambiente interpolada deixaria um `.env` de
# dev montar o proxy num stack `prod`, e aí `/healthz` do `web` responderia `502`
# e o ALB tiraria a SPA do ar. `export` vale para toda receita que chame o compose.
NGINX_CONF := $(if $(filter dev,$(PROFILE)),./frontend/nginx.dev.conf,./frontend/nginx.conf)
export NGINX_CONF

# Postgres descartável do nível de integração. Porta 55432 para não colidir com a
# 5432 do compose de dev — e credenciais próprias, que não são segredo: o
# container escuta só em 127.0.0.1 e o volume morre com `make db-test-down`.
DB_TEST_NAME := skills-db-test
DB_TEST_PORT ?= 55432
DB_TEST_IMAGE := postgres:16-alpine
DB_TEST_URL ?= postgresql://skills:skills@127.0.0.1:$(DB_TEST_PORT)/skills_test

.PHONY: bootstrap up down logs migrate seed test test-web test-integration test-all \
        test-coverage offline-check db-test-up db-test-down migrate-test \
        lint config help preflight lockfile openapi openapi-check \
        port port/free dev/start dev/stop ingest

help:
	@echo "alvos: dev/start | dev/stop | port | port/free | ingest | bootstrap | up | down | logs | migrate | seed | test | test-web | lint | config | openapi | openapi-check"
	@echo "       test-integration | test-all | test-coverage | offline-check | db-test-up | db-test-down | migrate-test"
	@echo "  bootstrap  gera pnpm-lock.yaml (exige Node 22 nativo no WSL e rede)"
	@echo "  dev/start  checa as portas, libera o que e nosso e sobe tudo + seed (uso diario)"
	@echo "  dev/stop   derruba o stack do profile $(PROFILE)"
	@echo "  port       mostra o estado das portas do backend e do frontend"
	@echo "  port/free  libera as portas que pertencem a este repositorio"
	@echo "  ingest     um ciclo de rodizio REAL (720 chaves da fonte); e o que o cron chama a cada 6 h"
	@echo "  up         sobe postgres + API + web no profile $(PROFILE)"
	@echo "  test       unit + api (sem Docker; é o gate rápido)"
	@echo "  test-web   roda a suíte do frontend (Vitest + Testing Library + MSW)"
	@echo "  test-integration  nível de integração contra Postgres real em 127.0.0.1:$(DB_TEST_PORT)"
	@echo "  test-all   test + test-integration (os três níveis)"
	@echo "  test-coverage  três níveis com cobertura do domínio e JUnit em backend/coverage/"
	@echo "  offline-check  prova que unit + api passam sem rede (unshare -rn + canário + anti-skip)"
	@echo "  db-test-up | db-test-down  sobe/derruba o Postgres descartável de teste"
	@echo "  migrate-test  aplica as migrations no banco de teste"
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


# --- uso diario: portas, subir e derrubar -------------------------------------
#
# `dev/start` e o alvo do dia a dia. Ele NAO assume que as portas estao livres:
# a 8080 deste host ja esteve presa por um proxy orfao do Docker Desktop, e o
# `up` falhava com "address already in use" no meio. A ordem e: checar, liberar o
# que e NOSSO, conferir de novo, subir, esperar o healthcheck, migrar e semear.
#
# `port/free` nunca mata processo alheio: se a porta pertence a outro programa,
# ele diz quem e para, porque matar o que nao e nosso seria pior que o erro.
# O `-` no inicio da receita: o codigo de saida diz o ESTADO (0 livre, 2 nossa,
# 3 alheia) e o `dev/start` o usa; o `make port` so informa e nao deve falhar.
port:
	-@bash scripts/dev/port.sh list

port/free:
	@bash scripts/dev/port.sh free

dev/start: lockfile
	@echo "== portas =="
	@bash scripts/dev/port.sh list || $(MAKE) --no-print-directory port/free
	@bash scripts/dev/port.sh assert-free || { echo "portas ainda ocupadas; resolva acima e repita"; exit 1; }
	@echo "== subindo (profile $(PROFILE)) =="
	$(COMPOSE) --profile $(PROFILE) up -d --build
	@bash scripts/dev/port.sh wait
	@echo "== migrations + seed =="
	@$(MAKE) --no-print-directory seed
	@bash scripts/dev/port.sh url

dev/stop:
	$(COMPOSE) --profile $(PROFILE) down --remove-orphans
# `migrate deploy` é idempotente: aplica só o que ainda não está em
# `_prisma_migrations`, então pode rodar em todo deploy. Sem `--no-deps`: o `run`
# sobe o `postgres` e espera o healthcheck antes de aplicar a migration.
migrate: lockfile
	$(API_RUN) npm run --silent prisma:deploy

# TODO(F2.3): virar `pnpm ingest:fixture` quando a ingestão existir.
# `docker compose run` (não `exec`): o stack não precisa estar de pé, e o volume
# extra traz a fixture, que não entra na imagem de dev. Dentro do container o workdir
# já É o pacote backend, então `pnpm seed` (sem `--dir backend`, que o $(PNPM) traz).
# O Postgres do compose não
# publica porta no host, então o seed tem de rodar na rede dele.
seed: migrate
	$(COMPOSE) --profile $(PROFILE) run --rm \
	  -v "$(PWD)/backend/test/fixtures:/app/test/fixtures:ro" \
	  $(API_SERVICE) pnpm seed

# Um ciclo de ingestão **real** (`pnpm ingest`): a fonte vem de `SKILL_SOURCE_KIND`
# e o rodízio escolhe 720 chaves. É o comando que o agendador do deploy chama a
# cada 6 h — o `seed` acima é só a fixture de desenvolvimento e NÃO deve rodar em
# produção (injetaria 25 skills de teste no catálogo).
#
# Sem `migrate` como pré-requisito ao contrário do `seed`: o cron roda contra um
# banco que já foi migrado pelo deploy, e uma migration travada não pode impedir o
# ciclo de rodar (ele falha alto e o log diz por quê).
#
# Exemplo de cron (host/EC2, ver `docs/app/05-ingestao-e-frescor.md`):
#   0 */6 * * *  cd <repo> && make ingest >> /var/log/skill-finder-ingest.log 2>&1
ingest:
	$(COMPOSE) --profile $(PROFILE) run --rm $(API_SERVICE) pnpm ingest

test: preflight
	$(PNPM) test
	$(PNPM) test:e2e

# Postgres descartável do nível de integração. Idempotente: se o container já
# existe, só o inicia; a espera é `pg_isready` em laço (nunca `sleep` fixo).
# O Jest NUNCA sobe Docker: quem orquestra é o make, e o harness em
# `backend/test/integration/db.ts` só consome a URL já de pé.
db-test-up:
	@docker inspect $(DB_TEST_NAME) >/dev/null 2>&1 || docker run -d --name $(DB_TEST_NAME) -e POSTGRES_USER=skills -e POSTGRES_PASSWORD=skills -e POSTGRES_DB=skills_test -p 127.0.0.1:$(DB_TEST_PORT):5432 $(DB_TEST_IMAGE)
	@docker start $(DB_TEST_NAME) >/dev/null 2>&1 || true
	@i=0; until docker exec $(DB_TEST_NAME) pg_isready -U skills -d skills_test >/dev/null 2>&1; do \
	  i=$$((i + 1)); \
	  if [ "$$i" -ge 30 ]; then \
	    echo "ERRO: o Postgres de teste nao ficou pronto em 30s ($(DB_TEST_NAME))."; \
	    echo "      Veja 'docker logs $(DB_TEST_NAME)' e 'make db-test-down' para recriar."; \
	    exit 1; \
	  fi; \
	  sleep 1; \
	done; \
	echo "db-test: pronto em 127.0.0.1:$(DB_TEST_PORT) (banco skills_test)"

db-test-down:
	@docker rm -f -v $(DB_TEST_NAME) >/dev/null 2>&1 || true
	@echo "db-test: container $(DB_TEST_NAME) e volume anonimo removidos (se existiam)"

# `migrate deploy` é idempotente e não usa o `--schema` do dev: a URL vem do
# ambiente, então o mesmo alvo serve para o banco descartável.
migrate-test: db-test-up
	DATABASE_URL=$(DB_TEST_URL) $(PNPM) prisma:deploy

# O banco é pré-requisito do make, não do teste: se estiver ausente, db.ts lança
# com "rode make db-test-up" — banco ausente é vermelho, nunca verde.
test-integration: preflight migrate-test
	TEST_DATABASE_URL=$(DB_TEST_URL) $(PNPM) test:integration

# Os três níveis. `test` continua sem Docker de propósito: é o gate rápido.
test-all: test test-integration

# Cobertura dos três níveis: unit + integração + api, com JUnit XML em
# `backend/coverage/`. O nível api carrega `@scalar` (ESM-only), daí o
# `NODE_OPTIONS=--experimental-vm-modules` dentro do script `test:cov`.
test-coverage: preflight migrate-test
	$(PNPM) test:cov

# Prova de offline, não declaração: netns sem rede (`unshare -rn`), canário que
# reprova se a rede estiver alcançável e anti-skip sobre o `--json` do Jest.
offline-check: preflight
	bash backend/test/offline/offline-check.sh

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
