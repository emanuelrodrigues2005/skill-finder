# CONTEXT.md — Skill Finder

Vocabulário do domínio e mapa do repositório. Em conflito de **produto ou contrato**, vencem
`docs/app/01`–`03`; em **nome de coisa**, vence este arquivo. Regra de sessão: `AGENTS.md`.

## 1. O que é

O Skill Finder recebe, em linguagem natural, a descrição da skill de agente que a pessoa precisa e
devolve uma lista curta, **ordenada e explicada** de skills do catálogo do **skills.sh**.
A LLM interpreta o pedido e redige o porquê; a ordem sai de uma função pura do backend — a LLM
nunca escolhe posição. O produto **não instala** a skill: decide qual instalar e mostra a origem.
Projeto 2 de Computação em Nuvem (UFRPE): monorepo NestJS + React, na AWS Academy por Terraform,
com pipeline CI/CD e observabilidade. Interface em português (pt-BR), documentação em português.

## 2. Glossário do domínio

| termo | definição | onde aparece no código |
| --- | --- | --- |
| **skill** | Item do catálogo: pacote de instruções de agente publicado no skills.sh, com repositório de origem, estrelas, instalações e status de segurança. O produto diz *qual* instalar; não instala. | `backend/prisma/schema.prisma` (model `Skill`); `frontend/src/types.ts` (`SkillSummary`) |
| **`SKILL.md`** | Documento longo da skill, texto de terceiro. Baixado sob demanda, truncado, cacheado 7 dias e usado no prompt como **dado** delimitado. | `backend/prisma/schema.prisma` (`SkillDocument`); download em `backend/src/catalog/` (F2.3) |
| **catálogo** | Conjunto de skills e categorias vigente no Postgres, produto da última ingestão bem-sucedida. Nunca vem da LLM. | `backend/prisma/schema.prisma` (`Category`, `Skill`); leitura em `backend/src/catalog/` (F2.3) |
| **ingestão** | Job idempotente que lê a fonte externa e faz upsert do catálogo, registrando um `ingest_run`. Roda a cada 6 h, no boot e por `POST /api/v1/admin/ingest`. | `backend/src/catalog/` + `@nestjs/schedule` (F2.3); `backend/prisma/schema.prisma` (`IngestRun`) |
| **`ingest_run`** | Uma execução de ingestão: status `running`/`ok`/`partial`/`failed` e contadores. A última `ok` define o snapshot; índice único parcial garante uma por vez. | `backend/prisma/schema.prisma`; lock descrito em `backend/prisma/migrations/README.md` |
| **intent** | Interpretação estruturada do pedido: `{category, keywords[], filters, language, confidence}`, validada contra a tabela `category`. | contrato em `frontend/src/types.ts`; produção em `backend/src/llm/` (F2.5); `search_request.intent` |
| **`intent_hash`** | Hash canônico do intent normalizado, componente da chave de cache para não repetir chamada de LLM. O contrato chama o composto de `cache_key` e não usa este nome — ver C1. | `docs/app/03-plano-app.md`; tabela `llm_cache` (`backend/prisma/schema.prisma`) |
| **candidato** | Skill que passou pelos filtros duros e pela recuperação lexical, antes do score. Conjunto fechado: a LLM só pode citar id daqui. | recuperação em `backend/src/search/` (F2.6); `search_request.candidates_count` |
| **score** | Número de 0 a 1 que ordena a lista: `round((0,5·S + 0,3·P + 0,2·I) × (1 − 0,10·m), 4)`. Só o backend calcula. | `backend/src/ranking/` (F2.4); pesos em `backend/src/config/env.schema.ts` |
| **`score_breakdown`** | Os fatores `S`, `P`, `I` mais `missing_fields` e `penalty_factor`: permitem recalcular o score na mão (tolerância 1e-4). | `frontend/src/types.ts`; produtor em `backend/src/ranking/` (F2.4) |
| **`evidence_completeness`** | Quanta evidência real existe para o item: `{missing_fields, penalty_factor}`. Campo ausente usa fator neutro 0,5 e vira `n/a` na tela. | `frontend/src/types.ts`; regra em `docs/app/01-spec-produto.md` §5.5 |
| **degraded** | Resposta válida, porém pior: `source_stale` (catálogo acima de 6 h) ou `llm_unavailable` (sem prosa da LLM). Sempre visível na tela. | `frontend/src/types.ts`; `search_request.degraded` |
| **`client_hash`** | Pseudônimo do cliente: `sha256(ip + IP_HASH_SALT)`. Identifica rate limit e histórico; não é conta, não é cookie. | `search_request.client_hash`; sal obrigatório em prod (`backend/src/config/env.schema.ts`) |
| **permalink / `request_id`** | `request_id` (`req_…`) identifica toda resposta e é o endereço do histórico: `GET /api/v1/searches/{request_id}` reabre a busca original. | `search_request.request_id`; `backend/src/common/request-id.middleware.ts`; consumo em `frontend/src/api.ts` |
| **fixture** | Catálogo congelado em arquivo: o caminho de dev/CI, para nenhum teste depender de rede, e a rede de segurança da demo. | `SKILL_SOURCE_KIND=fixture` (`backend/src/config/env.schema.ts`); dataset em `backend/test/fixtures/` (F2.3); amostra real em `docs/app/amostras/` |
| **`SkillSource`** | Porta de aquisição do catálogo, por chave: `listCategories()`, `fetchSkills(keys)` (devolve só as `source_key` conhecidas, na ordem pedida, e nunca lança), `fetchDocument(key)`. `fetchCatalog(page)` continua por compatibilidade, **`@deprecated`** — sai na #46. Normaliza o formato do skills.sh; o domínio só vê `SkillRecord`. | `backend/src/catalog/` (F2.3); contrato em `docs/app/02-arquitetura.md` §7.1 |
| **`LLMProvider`** | Porta da LLM: `extract_intent()` e `explain()`. Cliente OpenAI-compatible; o provedor falso de teste entra por injeção de dependência. | `backend/src/llm/` (F2.5); variáveis em `backend/src/config/env.schema.ts` |
| **`catalog_snapshot`** | Marca da última ingestão `ok`. Garante que resposta e cache falem do mesmo dado. | `data.catalog_snapshot` (`frontend/src/types.ts`); origem em `ingest_run` |
| **fallback de template** | Explicação determinística montada com os números do banco, quando a LLM falha ou devolve id inválido. | `backend/src/llm/` (F2.5); regras em `docs/app/02-arquitetura.md` §7.4 |
| **placeholder `{{skill:<skill_id>}}`** | Única forma de citar uma skill na prosa; o backend troca pelo `name` do banco. Nome inventado não é renderizado. | `docs/app/02-arquitetura.md` §5.3; resolução em `backend/src/llm/` (F2.5) |

## 3. Invariantes

1. **A LLM nunca ordena.** Ordem, `score`, filtros e recomendação são do backend, em função pura: sem I/O, sem relógio, sem `random`. → `docs/app/02-arquitetura.md` ADR-001; `backend/src/ranking/` (F2.4).
2. **A LLM nunca cita skill fora do conjunto recuperado.** Saída com `enum` de ids; nome só por placeholder. → ADR-004; `backend/src/llm/` (F2.5).
3. **Campo ausente é `null`, nunca `0` nem nota máxima.** Fator neutro 0,5, `missing_fields`, `n/a` na tela. → `docs/app/01-spec-produto.md` §5.5; `frontend/src/types.ts`.
4. **Texto externo é dado não confiável.** Consulta, `summary` e `SKILL.md` entram delimitados, só na mensagem de usuário; saída validada por schema. → `docs/app/02-arquitetura.md` §8.3; ADR-004.
5. **A chave da LLM só vive no backend.** O navegador fala apenas `/api/v1`; nenhuma chamada ao provedor, nenhuma chave no bundle. → `frontend/src/api.ts`; §8.1.
6. **Nenhum teste abre socket.** `nock.disableNetConnect()` no setup do Jest; catálogo de `backend/test/fixtures/`. → `backend/test/setup.ts`.
7. **Degradação é visível.** `degraded` + `degraded_reason` + `warnings`; a tela nunca mostra lista vazia sem explicação. → `frontend/src/types.ts`; §7.4.
8. **Filtro é corte, não penalidade.** `security_status = 'fail'` e `is_active = false` não aparecem em nenhuma posição. → `docs/app/01-spec-produto.md` §5.2.
9. **Interface em português (pt-BR), documentação em português.** Rótulos e estados vazios em `frontend/src/`; prosa em `docs/` e neste arquivo. Texto vindo do catálogo (`name`, `summary`, `SKILL.md`, rótulo de categoria) não é traduzido.

## 4. Mapa do repositório

| pasta | o que mora | o que **não** mora | comando que a exercita |
| --- | --- | --- | --- |
| `backend/` | NestJS 11 + Prisma: `src/` (`config`, `common`, `prisma`, `health` hoje; `catalog/`, `ranking/`, `llm/`, `search/` na F2.3–F2.6), `prisma/schema.prisma`, `test/` | ranking fora de `src/ranking`; rede em teste; chave de LLM | `make test` · `pnpm --dir backend typecheck` |
| `frontend/` | React + Vite + TS: 3 telas (`src/pages/`), `src/api.ts` (só `/api/v1`), `src/types.ts` (contrato v0), `nginx.conf` (SPA + proxy) | chave de LLM; chamada ao skills.sh; lista fixa de categorias | `pnpm --dir frontend run lint` · `make up` (serviço `web`) |
| `docs/` | `00`–`04` do projeto acadêmico; `app/` com spec, arquitetura, plano e `amostras/`; `evidencias/` | código; critério de aceitação de issue (vive na issue) | `python scripts/dev/validate_docs.py` · índice em `docs/README.md` |
| `infra/` | **ainda não existe** — nasce na F3: Terraform (state no S3, EC2, ECR, security group, as 4 saídas do seam) | segredo; `tfstate` versionado; lógica de aplicação | `terraform -chdir=infra validate` · `plan` (F3) |
| `scripts/` | automação de apoio: `sandbox-check.sh`, `install-toolchain-*`, `bootstrap-state.sh`, `probe-skills-sh.sh`, `dev/*.py`, `dev/collect-skills-sample.ps1`, `github/publish-tracker.ps1` + `github/issues/f0–f6.md` | lógica de aplicação; regra de negócio | `pwsh scripts/github/publish-tracker.ps1 -ValidateOnly` |
| `observability/` | **ainda não existe** — nasce na F5: Prometheus, Loki, Grafana e os 4 painéis versionados | configuração da aplicação | hoje `curl -sS localhost:8080/metrics`; depois `/grafana` no `make up` |
| `.github/` | `pull_request_template.md` hoje; `workflows/` (CI e deploy) na F4 | corpo de issue (vive em `scripts/github/issues/`); segredo | `gh pr checks` · `gh pr view` |
| `tasks/` | `plan.md`: índice das issues por milestone F0–F6, ADRs herdadas e riscos | critério de aceitação (vive na issue); `tasks/todo.md` (não existe de propósito) | `pwsh scripts/github/publish-tracker.ps1 -ValidateOnly` |

## 5. Fluxo de uma busca

1. **Entrada** — `POST /api/v1/search`: valida `query` (3–500), `category` contra a tabela `category` e `limit` ≤ 20; aplica rate limit por `client_hash`. → `backend/src/search/` (F2.6).
2. **Cache de busca** — `search_hash` com validade de 10 min; hit devolve a resposta original. → `backend/src/search/` (F2.6).
3. **Intent** — `LLMProvider.extract_intent(query, categorias)` devolve `intent` validado; `category` fora do catálogo vira `null`; `confidence < 0,35` cai para o fallback lexical. → `backend/src/llm/` (F2.5).
4. **Candidatos** — `tsvector` + `pg_trgm` sobre `skill`, com os filtros duros; conjunto fechado de ≤ 5. → `backend/src/catalog/` + `$queryRaw` (F2.6).
5. **Ranking** — `backend/src/ranking/` calcula `score` e desempata por `(-score, vulns, -installs, -stars, skill_id)`. **É aqui que o determinismo é garantido.**
6. **Explicação** — `LLMProvider.explain(intent, candidatos)` devolve `why`/`caveats` com placeholder e `enum` de ids; um reparo e, persistindo o erro, fallback de template. → `backend/src/llm/` (F2.5).
7. **Resposta** — montada do banco: `results[].skill`, `score_breakdown`, `recommendation = results[0]`, `degraded`; grava `search_request` e devolve `request_id` (permalink). → `backend/src/search/` (F2.6).

Determinismo: as etapas 1, 2, 4, 5 e 7 são backend puro; 3 e 6 são da LLM, mas presas a schema, `enum` e fallback — e nenhuma delas escreve `score`, ordem ou qual skill existe.

## 6. Ambiguidades conhecidas

### 6.1 Abertas por decisão externa

- **A1 · Forma de acesso ao skills.sh** — **RESOLVIDA em 2026-11-15: D3 (scraping de DOM)**, com amostra real em `docs/app/amostras/`. O site não publica contagem de vulnerabilidades: o campo fica `null`. Issue `chore(catalog): descobrir e congelar a fonte de dados do skills.sh`.
- **A2 · `response_format` do provedor:** aceita `json_schema` ou só `json_object`? Define a força da barreira do ADR-004. `docs/app/02-arquitetura.md` §11 Q2; issue `feat(llm): IntentParser…`.
- **A3 · Categorias do skills.sh:** lista fixa? quais `slugs`? Até a resposta, `category = null` e o seletor é populado na ingestão. §11 Q4.
- **A4 · Quem serve o `SKILL.md`:** skills.sh ou `raw.githubusercontent.com`? Hoje: tentar skills.sh, cair para o GitHub, cache de 7 dias, falha silenciosa. §11 Q5.

### 6.2 Contradições entre documentos (não resolvidas aqui)

- **C1 · `intent_hash`.** O plano usa `(skill_id, intent_hash)`; o contrato define `cache_key = sha256(kind|prompt_version|model|intent_normalizado|sorted(candidate_ids)|catalog_snapshot)` e não nomeia `intent_hash`. **Pergunta:** vale o `cache_key` do §4.1 e `intent_hash` é só o componente `intent_normalizado`?
- **C2 · Frescor do catálogo.** `01` §6.2 e `02` §4.2 dizem 6 h; `03-plano-app.md` diz TTL de 24 h e cria `GET /api/catalog/status`, endpoint ausente do contrato. **Pergunta:** 6 h vale e `/catalog/status` está descartado?
- **C3 · Quantos endpoints no v0.** 8 (issue de contrato) ou 10 (`02` §5.1, que soma `/admin/ingest` e `/admin/ingest/runs`)? **Pergunta:** os dois de admin entram no v0?
- **C4 · Explicação da LLM.** Top-3 ou todos os ≤ 5 candidatos? **Pergunta:** confirma 5, com template para o que faltar?
- **C5 · `LLM_PROVIDER`.** Não existe em `env.schema.ts`; o switch real é `LLM_ENABLED` (bool). **Pergunta:** o provedor falso é só injeção de teste e `LLM_ENABLED=false` é o modo degradado de dev/CI?
- **C6 · UI de referência.** `main.ts` sobe Swagger UI em `/docs`; `@scalar/nestjs-api-reference` não está instalado. **Pergunta:** a troca entra na issue do contrato (F2.1) ou em issue própria? *(Resolvido: issue própria, criada na milestone F2.)*
- **C7 · Template de issue.** `.github/ISSUE_TEMPLATE/` não existe; o corpo vem de `scripts/github/issues/fN.md` via `publish-tracker.ps1`. **Pergunta:** criar os templates ou manter a publicação por script como caminho único?
