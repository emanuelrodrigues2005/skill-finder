# Plano de Implementação — Skill Finder (Projeto 2, UFRPE)

> **O tracker é o GitHub Issues deste repositório.** Este documento é o **índice** das issues
> (milestones F0–F6), não uma duplicata: critério de aceitação, comando de verificação e evidência
> vivem na issue. `tasks/todo.md` **não** existe de propósito — o *task list target* deste projeto é
> o GitHub Issues (`AGENTS.md`). Não há GitHub Projects: o token do dono não tem o escopo `project`.
>
> Publicação: `scripts/github/publish-tracker.ps1` lê `scripts/github/tracker.json` e os corpos em
> `scripts/github/issues/f0–f6.md`. `-ValidateOnly` confere a consistência sem rede; `-Apply` publica.

## Overview

O **Skill Finder** recebe uma descrição em linguagem natural, usa uma LLM para interpretar a
intenção, consulta o catálogo do **skills.sh** e devolve uma lista **ranqueada e explicada** de
skills de agentes. A ordem é uma **função pura do backend**; a LLM só interpreta e redige o
"porquê". Entrega acadêmica: aplicação no ar na AWS Academy, por Terraform, com pipeline CI/CD,
testes em três níveis, segredos no cofre e observabilidade — fases **F0–F6** de
`docs/04-plano-de-execucao.md` §2, avançando por **gates** (§8).

## Architecture Decisions

Todas **herdadas** — nenhuma é redecidida por este plano.

| Decisão | Origem | O que fica fixo |
| --- | --- | --- |
| **Opção 1**: uma EC2 + Docker Compose, imagem no ECR, `tfstate` no S3, segredos no Infisical. ALB/RDS/ECS fora | `docs/01` §5.1; `docs/04` §3/F3 | a topologia do `user_data` e as **4 saídas do seam** |
| **ADR-007** — NestJS 11 + TypeScript strict, Prisma, Jest/Supertest/nock | `docs/app/02` §10 | stack e nomes de script (`pnpm --dir backend …`) |
| **ADR-001** — a LLM interpreta e explica; o ranking é determinístico | `docs/app/02` §10 | fórmula `0,5·S + 0,3·P + 0,2·I`, penalidade de 10%/campo, desempate total, pesos em `RANK_W_*` |
| **ADR-002** — busca lexical (`tsvector` + `pg_trgm`) na v1 | `docs/app/02` §10 | sem pgvector, sem serviço de embedding |
| **ADR-003** — `SkillSource` com adaptadores `json`/`html`/`fixture` | `docs/app/02` §10 | `SKILL_SOURCE_KIND`; `fixture` é o caminho de dev/CI |
| **ADR-004** — conjunto fechado de IDs + `{{skill:<id>}}` | `docs/app/02` §10 | saída da LLM validada por schema |
| **ADR-005** — monorepo, um `compose.yaml` com profiles | `docs/app/02` §10 | duas imagens (`api`, `web`) |
| **ADR-006** — cache, rate limit e agendador na API, com Postgres | `docs/app/02` §10 | sem Redis/fila; lock em `ingest_run` |
| **Sem autenticação de usuário** — identidade é `client_hash = sha256(ip + salt)` | `docs/app/01` §6.3 | nada de login/JWT/senha em nenhuma issue |
| **Pesos do edital** C1 25% · C2 20% · C3 15% · C4 15% · C5 10% · C6 5% · C7 5% · C8 5% | `docs/00` §7 | a prioridade das issues segue estes pesos |

## Task List

Índice das issues por milestone. `[x]` = já fechada, com o commit que a entregou.

### F0 — Pré-requisitos e sandbox
- [x] Validar o sandbox AWS Academy (K1–K14) — `c8b1840`, `b9a3b93`
- [x] `chore(toolchain):` fixar pnpm 12 e Dockerfiles no WSL — `acf6a2f`

**Checkpoint F0:** K1–K14 datados em `docs/evidencias/sandbox.md`; `.gitignore` cobre segredo;
`git status` limpo.

### F1 — Proposta e decisões
- [ ] Obter aprovação do professor para a proposta E1 — **`p0`, bloqueia a F2**

**Checkpoint F1:** E1 com os 4 itens do §6.1; escopo datado; ADR-0001; Q1–Q6 respondidas ou com
padrão declarado; **Q7 (Tema D) registrada**; data e conclusão da aula em `docs/evidencias/`.

### F2 — Aplicação
- [ ] `chore(catalog):` descobrir e congelar a fonte de dados do skills.sh — **`p0`**
- [ ] `feat(api):` congelar contrato OpenAPI v0 com 8 endpoints
- [x] `feat(api):` esqueleto NestJS com `/healthz`, `/readyz` e `/metrics` — `a3efa68`
- [ ] `feat(catalog):` ingestão idempotente com `SkillSource` e fixture
- [ ] `feat(ranking):` score determinístico com desempate estável
- [ ] `feat(llm):` `IntentParser` com provedor **fake** e cliente OpenAI-compat
- [ ] `feat(api):` endpoints de busca, *permalink* e detalhe
- [ ] `feat(web):` três telas consumindo o contrato
- [ ] `test(api):` três níveis de teste e suíte offline
- [ ] `fix(api):` bloquear prompt injection e aplicar limites

**Checkpoint F2:** `pnpm --dir backend test` verde com cobertura ≥ 80%; `make offline-check` verde;
`docker compose config -q` = 0; dados persistem após restart; 3 telas sem erro de console;
`openapi.yaml` sincronizado.

### F3 — Infraestrutura como código
- [ ] `feat(infra):` base do Terraform com backend S3 e rede
- [ ] `feat(infra):` EC2, ECR e primeiro ciclo de `apply`/`destroy`

**Checkpoint F3:** `fmt -check` e `validate` limpos; `apply` sem `-auto-approve`; segundo `plan`
"No changes."; app em HTTP; `state list` ≥ 8 sem `aws_iam_*`; **`destroy` sem órfãos**; runbook.

### F4 — Pipeline CI/CD
- [ ] `ci:` workflow de CI com lint, três níveis e gitleaks
- [ ] `ci:` deploy automatizado com smoke e gate de testes provado

**Checkpoint F4:** execução verde com os 7 jobs; execução vermelha com `build`/`deploy` `skipped`
arquivada; imagem no ECR com tag = SHA; branch padrão protegido.

### F5 — Observabilidade e segredos
- [ ] `feat(observability):` Prometheus, Loki, Grafana e 4 painéis
- [ ] `feat(security):` segredos no Infisical e `.env` gerado no deploy

**Checkpoint F5:** alvos `UP`; 4 painéis com dados datados; log consultável por `request_id`;
`/grafana` autenticado; `.env` do cofre com `chmod 600`.

### F6 — Entrega
- [ ] `docs:` README, runbook, segurança e observabilidade finais
- [ ] `chore(release):` ensaio cronometrado e demo de 3 minutos

**Checkpoint F6:** ciclo `destroy`→`apply`→`deploy`→`smoke` em < 15 min registrado; demo ensaiada
com vídeo de fallback; `gitleaks` e `fmt` limpos; checklist da §11 100%.

## Risks and Mitigations

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| **A1** — skills.sh bloqueia acesso automatizado | Alto em C1 | decisão **D4**: *fixture-first*, sem rede no caminho da busca; limitação documentada |
| **A6** — CI quebra por dependência externa | Alto em C4/C5 | `nock.disableNetConnect()`, fixture, `LLM_PROVIDER=fake`; `make offline-check` antes do CI |
| **R01** — sessão do lab expira no meio do `apply` | Médio | `apply` no início da sessão; `preflight` no `deploy.yml` |
| **R02/R12** — crédito acaba / professor exige RDS-ALB na véspera | Alto | `destroy` ao fim de cada sessão; *seam* das 4 saídas permite Opção 2 só na janela da demo |
| **R07** — teste *flaky* reprovando o pipeline | Médio | Postgres com `healthcheck`, relógio injetado, `TZ=UTC`, sem `sleep` |
| **R08** — segredo vazado | Alto | `::add-mask::`, `gitleaks`, redação de `authorization` |
| **Ordem real ≠ plano** — o contrato (F2.1) está aberto, mas o esqueleto foi entregue antes | Médio | o contrato passa a ser pré-requisito explícito da ingestão, dos endpoints e do frontend |

## Open Questions

1. **D1–D5**: como o skills.sh entrega os dados? Enquanto não fechar, `SKILL_SOURCE_KIND=fixture`.
2. **Endpoint do opencode**: aceita `response_format` com `json_schema`? Cota e custo por 1k tokens?
3. **Q1, Q4, Q5** de `docs/04` §12: SPA separada é exigida? HTTP sobre IP público é aceito? O
   ambiente precisa ficar no ar fora da sessão?
4. **Q7 / Tema D**: o professor aceita "descoberta de skills de agentes"? Sem registro, a F2 pode ser
   contestada na banca.
5. **Categorias do skills.sh**: sem a lista, `category` fica `null` e o seletor é populado na ingestão.
6. **`SKILL.md`**: servido pelo skills.sh ou por `raw.githubusercontent.com`? Decide o cache de 7 dias.
