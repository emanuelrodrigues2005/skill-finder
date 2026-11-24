# Plano de Implementação — Skill Finder (Projeto 2, UFRPE)

> **O tracker é o GitHub Issues deste repositório.** Este documento é o **índice** das issues
> (milestones F0–F6), não uma duplicata: critério de aceitação, comando de verificação e evidência
> vivem na issue. `tasks/todo.md` **não** existe de propósito — o *task list target* deste projeto é
> o GitHub Issues (`AGENTS.md`). Não há GitHub Projects: o token do dono não tem o escopo `project`.
>
> Publicação: `scripts/github/publish-tracker.ps1` lê `scripts/github/tracker.json` e os corpos em
> `scripts/github/issues/f0–f7.md`. `-ValidateOnly` confere a consistência sem rede; `-Apply` publica.

## Overview

O **Skill Finder** recebe uma descrição em linguagem natural, usa uma LLM para interpretar a
intenção, consulta o catálogo do **skills.sh** e devolve uma lista **ranqueada e explicada** de
skills de agentes. A ordem é uma **função pura do backend**; a LLM só interpreta e redige o
"porquê". Entrega acadêmica: aplicação no ar na AWS Academy, por Terraform, com pipeline CI/CD,
testes em três níveis, segredos no cofre e observabilidade — fases **F0–F7** de
`docs/04-plano-de-execucao.md` §2, avançando por **gates** (§8).

## Architecture Decisions

Todas **herdadas** — nenhuma é redecidida por este plano.

| Decisão | Origem | O que fica fixo |
| --- | --- | --- |
| **Opção 1**: uma EC2 + Docker Compose, imagem no ECR, `tfstate` no S3, segredos no Infisical. ALB/RDS/ECS fora | `docs/01` §5.1; `docs/04` §3/F3 | a topologia do `user_data` e as **5 saídas do seam** |
| **ADR-007** — NestJS 11 + TypeScript strict, Prisma, Jest/Supertest/nock | `docs/app/02` §10 | stack e nomes de script (`pnpm --dir backend …`) |
| **ADR-001** — a LLM interpreta e explica; o ranking é determinístico | `docs/app/02` §10 | fórmula `0,5·S + 0,3·P + 0,2·I`, penalidade de 10%/campo, desempate total, pesos em `RANK_W_*` |
| **ADR-002** — busca lexical (`tsvector` + `pg_trgm`) na v1 | `docs/app/02` §10 | sem pgvector, sem serviço de embedding |
| **ADR-003** — `SkillSource` com adaptadores `json`/`html`/`fixture` | `docs/app/02` §10 | `SKILL_SOURCE_KIND`; `fixture` é o caminho de dev/CI |
| **ADR-004** — conjunto fechado de IDs + `{{skill:<id>}}` | `docs/app/02` §10 | saída da LLM validada por schema |
| **ADR-005** — monorepo, um `compose.yaml` com profiles | `docs/app/02` §10 | duas imagens (`api`, `web`) |
| **ADR-006** — cache, rate limit e agendador na API, com Postgres | `docs/app/02` §10 | sem Redis/fila; lock em `ingest_run` |
| **Sem autenticação de usuário** — identidade é `client_hash = sha256(ip + salt)` | `docs/app/01` §6.3 | nada de login/JWT/senha em nenhuma issue |
| **Pesos do edital** C1 25% · C2 20% · C3 15% · C4 15% · C5 10% · C6 5% · C7 5% · C8 5% | `docs/00` §7 | a prioridade das issues segue estes pesos |
| **ADR-010 a ADR-017** — arquitetura distribuída da F7: ALB com DNS estável, três VMs por papel, banco em EC2 (RDS inviável por medição), observabilidade na VM do back, roteamento por caminho no ALB, cliente pelo `X-Forwarded-For`, deploy em três alvos em série e operação em janela | `docs/app/02` §10; `docs/evidencias/f7-alb-probe.txt` | a URL é o `alb_dns_name`; **um** `compose.yaml` fatiado por profile; `destroy` no fim de cada sessão |

**A F7 muda a topologia apenas na janela da demo** (ADR-017): três VMs + ALB enquanto a sessão estiver
ligada, `destroy` no fim. Fora da janela, a Opção 1 continua sendo o padrão, e `var.enable_alb=false`
é o plano B declarado — volta ao IP público com EIP + `sslip.io`.

## Task List

Índice das issues por milestone. `[x]` = entrega verificada no commit ou run citado (a issue no
GitHub fecha com o comentário de evidência quando revisada).

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
- [x] **F3.1** Validar sessao do lab, Terraform >= 1.10 e bucket de state — #54, `96fc9e5`
- [x] **F3.2** `feat(infra):` base do Terraform com backend S3 e data sources do IAM — #14, `ef5b6fb`
- [x] **F3.3** `feat(infra):` security group, key pair e VPC padrao — #55, `1de44bf`
- [x] **F3.4** `feat(infra):` EC2 com user_data, EBS de dados, ECR e as saidas do seam — #15, `9ef1902`
- [x] **F3.5** `feat(web):` /healthz e /readyz na borda do nginx — #56, `f80c3b6`
- [x] **F3.6** `docs(infra):` runbook de operacao (subir, implantar, destruir) — #57, `e6bcfed`
- [x] **F3.7** Gate: apply, smoke e destroy sem orfaos — #58, `599010e`

**Checkpoint F3:** `fmt -check` e `validate` limpos; `apply` sem `-auto-approve`; segundo `plan`
"No changes."; app em HTTP; `state list` ≥ 8 sem `aws_iam_*`; **`destroy` sem órfãos**; runbook.

### F4 — Pipeline CI/CD
- [x] `ci:` workflow de CI com lint, três níveis de teste e gitleaks — #16, `fa60294`, `bcabf50`
- [x] `ci:` deploy automatizado com smoke e gate de testes provado — #17, `5e567bd`, `264001b`, `a0e5084`, `2414ccc`

**Checkpoint F4:** execução verde com os 8 jobs; execução vermelha com `build`/`deploy` `skipped`;
prova em `docs/evidencias/f4-gate.md` (runs `45273346584` verde, `45273141415` e `44849868942`
vermelhos); imagem no Docker Hub público com tag = SHA. Pendência: `main` **não** está protegida
(`gh api .../branches/main/protection` → 404), registrada na §11 de `docs/04`.

### F5 — Observabilidade e segredos
- [x] `feat(observability):` Prometheus, Loki e Grafana no profile `obs` com 4 painéis — #18, `6ab90ac`
- [x] `feat(security):` fechar a demonstração de segredos (docs, `GRAFANA_PASSWORD`, provas) — #19, `9c85154`
- [x] `ci(infra):` subir a stack obs no deploy e expor o Grafana na borda — #62, `a0e5084`

**Checkpoint F5:** 5 containers no profile `obs` (ADR-009); 4 painéis versionados; `/grafana/`
autenticado; seis segredos no Infisical e nenhum `.env` no host; prova em
`docs/evidencias/f5-seguranca.txt`.

### F6 — Entrega
- [x] `docs:` README final, verdade da arquitetura e índice de evidências — #20
- [ ] `chore(release):` ensaio cronometrado, evidências vivas e demo de 3 minutos — #21
- [x] `docs:` reescrever o runbook §1–2 para o deploy por SSM — #63, `3dc3032`
- [x] `docs(evidencias):` arquivar a prova do pipeline (verde, vermelho e gate) — #64, `0ca5234`
- [ ] `chore(security):` rotacionar a `LLM_API_KEY` e revogar a machine identity — #65

**Checkpoint F6:** ciclo `destroy`→`apply`→`deploy`→`smoke` em < 15 min registrado; demo ensaiada
com vídeo de fallback; `gitleaks` e `fmt` limpos; checklist da §11 100%.

### F7 — Arquitetura distribuída
- [x] **F7.1** `chore(infra):` provar que o ALB cria, fica `active` e destrói no lab — #67, `3b3fb1a`
- [ ] **F7.2** `docs(app):` ADR-010 a ADR-017 e a milestone F7 no tracker — #68
- [ ] **F7.3** `feat(infra):` três instâncias por papel, quatro security groups e EBS — #69
- [ ] **F7.4** `feat(infra):` ALB com três target groups e regras de caminho — #70
- [ ] **F7.5** `feat(infra):` fatiar o compose por papel (web, api, db) — #71
- [ ] **F7.6** `fix(api):` identificar o cliente pelo `X-Forwarded-For` do ALB — #72
- [ ] **F7.7** `fix(web):` tirar do nginx do front o que o ALB passou a rotear — #73
- [ ] **F7.8** `ci(deploy):` implantar nas três VMs por tag de papel e smoke pelo ALB — #74
- [ ] **F7.9** `docs(infra):` runbook das três VMs, custo por hora e destroy sem órfãos — #75
- [ ] **F7.10** `chore(release):` ensaio cronometrado do ciclo F7 — #76

**Checkpoint F7:** veredito do ALB em `docs/evidencias/f7-alb-probe.txt` (`active` em 121 s, destruído
em 153 s, sem órfão); três VMs por papel (`t3.micro` no front, `t3.small` no back e no banco) e
`compose.yaml` único com profiles `web`/`api`/`db`/`obs`; deploy em série `db`→`api`→`web`; smoke pelo
DNS do ALB; custo por hora **0,1147** (ADR-017) com `destroy` ao fim de cada sessão; ensaio da janela
em `docs/evidencias/f7-ensaio.md`.

## Risks and Mitigations

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| **A1** — skills.sh bloqueia acesso automatizado | Alto em C1 | decisão **D4**: *fixture-first*, sem rede no caminho da busca; limitação documentada |
| **A6** — CI quebra por dependência externa | Alto em C4/C5 | `nock.disableNetConnect()`, fixture, `LLM_PROVIDER=fake`; `make offline-check` antes do CI |
| **R01** — sessão do lab expira no meio do `apply` | Médio | `apply` no início da sessão; `preflight` no `deploy.yml` |
| **R02/R12** — crédito acaba / professor exige RDS-ALB na véspera | Alto | `destroy` ao fim de cada sessão; *seam* das 5 saídas permite Opção 2 só na janela da demo |
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
