# AGENTS.md — Skill Finder (Projeto 2)

O usuário descreve, em linguagem natural, a skill de agente que precisa; a aplicação interpreta o
pedido com uma LLM, consulta o catálogo do **skills.sh** e devolve uma lista **ranqueada e
explicada**. O vocabulário do domínio está em [`CONTEXT.md`](CONTEXT.md): use os termos de lá —
skill, catálogo, ingestão, intent, candidato, score — e não sinônimos soltos.

Monorepo: `backend/` (NestJS 11 + TypeScript + Prisma), `frontend/` (React + Vite + TypeScript),
`docs/` (edital, análise, spec, arquitetura, planos), `infra/` (Terraform, a partir da F3),
`observability/` (a partir da F5).

Este arquivo é a regra que vale em toda sessão. O resto está nos documentos apontados na tabela
ao final.

## Comandos

Fonte de verdade: `Makefile` (`make up`, `down`, `logs`, `migrate`, `seed`, `test`, `lint`,
`config`). Dentro de `backend/` e `frontend/`, o gerenciador é **pnpm**.

Sem internet nesta máquina, `pnpm install` falha — instale quando houver rede.

**Verificação roda em ext4, nunca em `/mnt/c`.** O checkout vive em `/mnt/c`, que no
WSL é 9p — cada leitura atravessa a ponte com o Windows. Medido neste repositório
(65.681 arquivos em `node_modules`): `jest --listTests` leva **124 s** e uma suíte de
4 testes leva **451 s** em `/mnt/c`, contra **5,5 s** da mesma suíte em ext4. 95% do
tempo era espera de I/O, não CPU — foi isso que fez cada rodada custar ~15 min.

Use `bash scripts/dev/verify.sh [escopo]`: espelha `backend/` + `openapi.yaml` para
`~/cloud-verify` e roda lá. A cadeia completa cai de ~15 min para **~30 s**.
Escopos: `typecheck`, `openapi`, `unit`, `e2e`, `docs`, ou vazio para tudo.

- **Filho de agente roda UM escopo** (`verify.sh docs`), nunca a cadeia inteira; a
  verificação completa é do orquestrador, no fim da issue.
- `verify.sh --native` roda no `/mnt/c` — só para comparar, nunca no fluxo.
- O espelho é descartável: `--delete` a cada execução. Nada é escrito no checkout.

## Regras que não se deduzem do código

1. **O ranking é determinístico.** A ordem sai de `backend/src/ranking`, uma função pura: sem I/O,
   sem `Math.random`, sem relógio. A LLM interpreta a intenção e redige o *porquê*; ela nunca
   escolhe a ordem, nunca produz `score`, nunca cita uma skill fora do conjunto já recuperado.
2. **Texto externo é dado não confiável.** `SKILL.md`, resumo e a consulta do usuário entram
   delimitados e apenas na mensagem de usuário — nunca no *system prompt*. A saída é validada
   contra schema e campo fora do schema é descartado.
3. **Dado ausente é `null`, jamais zero.** `evidence_completeness` marca o item incompleto e a
   interface mostra `n/a`.
4. **A chave da LLM vive só no backend.** O navegador fala apenas com `/api/v1`; nenhuma chamada
   direta ao provedor, nenhuma chave no bundle.
5. **Nenhum teste abre socket.** `nock.disableNetConnect()` no setup do Jest; o catálogo vem de
   `backend/test/fixtures/`. O modo degradado de dev/CI é `LLM_ENABLED=false` — o nome
   `LLM_PROVIDER=fake` de versões anteriores **não existe** em `backend/src/config/env.schema.ts`;
   o provedor falso de teste entra por injeção de dependência na F2.5.
6. **Interface em português (pt-BR), documentação em português.** Rótulos, mensagens de erro e
   estados vazios da SPA; prosa em `docs/` e neste arquivo. O texto que **vem do catálogo** (`name`,
   `summary`, `SKILL.md`, rótulo de categoria) não é traduzido: é dado da fonte, mostrado como
   publicado.
7. **Degradação é visível.** Com a LLM fora do ar, a resposta traz `degraded: true` e a intenção
   vem do fallback por palavras-chave — a tela nunca mostra lista vazia sem explicação.

## Subagentes: quem escreve e quem devolve

| preset | quando usar | o que ele pode escrever | o que ele devolve |
| --- | --- | --- | --- |
| `researcher` | levantar fato externo ou estado do repo antes de decidir | **nada** — não tem ferramenta de escrita | achados com a fonte e o que não conseguiu verificar |
| `architect` | decidir entre desenhos, fronteiras de módulo, modelo de dados, ADR | **nada** | decisão, trade-offs, consequências e arquivos a tocar |
| `planner` | fatiar a entrega em issues e definir a ordem | **nada** | lista de issues com critério e comando de verificação |
| `reviewer` | revisar diff de código antes do commit | **nada** | veredito APPROVE / REQUEST CHANGES e o que corrigir |
| `security` | segredo, auth, CORS, rate limit, prompt, dependência, comando fora do workspace | **nada** | veredito, risco concreto e mitigação |
| `tester` | provar que o teste falha sem a mudança e passa com ela | **nada** | veredito sobre a suíte e os casos que faltam |
| `coder` | implementar em `backend/` ou `frontend/` | os arquivos do escopo que recebeu | diff + saída dos comandos de verificação |
| `devops` | `infra/`, `compose.yaml`, `.github/workflows/`, scripts de operação | os arquivos do escopo que recebeu | diff + saída dos comandos de verificação |

> **Armadilha que já custou retrabalho:** `researcher`, `architect`, `planner`, `reviewer`,
> `security` e `tester` **não têm ferramenta de escrita**. Pedir "grava o arquivo" a eles devolve o
> conteúdo na resposta e nada no disco. Quem grava é o orquestrador, com o conteúdo devolvido.
> Preset fora desta tabela: assuma que devolve conteúdo e confirme com o dono antes de deixá-lo
> escrever.

### Paralelismo

- No máximo **4 filhos** ao mesmo tempo.
- Cada filho recebe escopo de escrita **disjunto** — arquivos ou pastas declarados no brief; dois
  filhos nunca escrevem o mesmo arquivo.
- Quem integra é o **orquestrador**: junta as partes, roda a verificação (`make test`, `make lint`,
  `pnpm --dir backend typecheck`) e só então pede revisão.
- Filho que devolve conteúdo não integra nada; filho que escreve não aprova o próprio diff.

## Gate de revisão antes de commitar

Nenhum commit sem revisão por **outro** preset — quem escreveu não aprova o próprio trabalho.

| Tipo de mudança | Revisor obrigatório | O que ele verifica |
| --- | --- | --- |
| Código em `backend/` ou `frontend/` | `reviewer` | diff completo, aderência ao `docs/app/02-arquitetura.md`, testes, nomes, dead code |
| Testes novos ou alterados | `tester` | os testes falham sem a mudança e passam com ela; nada de teste que sempre passa |
| Contrato de API — `openapi.yaml`, DTO de `backend/src`, `frontend/src/types.ts` | `reviewer` **e** aviso à issue de `frontend` da mesma milestone | campo renomeado, `null` vs ausente, código de erro novo, ordem do `score` |
| Auth, segredos, `LLM_API_KEY`, CORS, rate limit, prompt, dependências | `security` **em adição** ao `reviewer` | vazamento de chave, superfície de injeção, permissões, dependência nova justificada |
| `docs/` apenas | dispensado | — |

O revisor recebe o **diff** e os **comandos de verificação com a saída**; sem saída de comando, o
gate não fecha. Se o revisor pedir ajuste, o autor corrige e pede nova revisão — no máximo duas
idas e voltas; na terceira, o agente para e reporta o bloqueio ao dono.

## Execução de comandos fora do workspace

O agente pode ler e editar arquivos do workspace livremente. **Executar** comando que saia do
workspace, use `sudo`, toque no WSL, instale software ou apague algo exige o gate abaixo.

| Passo | Regra |
| --- | --- |
| 1. Propor | o agente lista os comandos exatos, um por linha, com o efeito de cada um |
| 2. Revisar | preset `security` valida a lista: caminho absoluto conferido, nada destrutivo fora do workspace, `sudo` justificado linha a linha, sem `curl \| bash`, sem `rm -rf` em caminho computado |
| 3. Executar | só os comandos aprovados, na ordem aprovada; saída colada no relatório |
| 4. Mudança de plano | comando novo = nova revisão, mesmo que "pareça igual" |

Regras fixas:

- `sudo` só em comando aprovado individualmente; nada de `sudo -i`, `sudo su` ou script inteiro sob sudo.
- Antes de apagar ou mover: imprimir o caminho absoluto resolvido e conferir que está dentro do alvo esperado.
- Comando destrutivo (`rm -rf`, `git reset --hard`, `docker system prune`, `DROP`) nunca em lote.
- Se a execução falhar por sandbox/permissão, **parar** e reportar; não tentar contornar por conta própria.
- `danger-full-access` só quando o sandbox restrito bloqueia **TLS** (handshake que não completa —
  não erro de permissão de arquivo), com aprovação explícita do dono e o **hash do artefato
  fixado** antes e conferido depois. Qualquer outro bloqueio segue a regra anterior.

## Git: o que o agente pode fazer

**Permitido**, sempre em branch de trabalho (nunca direto em `main`):

| Operação | Condição |
| --- | --- |
| `git switch -c <branch>` | nome no padrão `<type>/<escopo-curto>` (ex.: `feat/nest-backend`) |
| `git add` + `git commit` | somente com o gate de revisão cumprido |
| `git push -u origin <branch>` | somente branch próprio, nunca `main` |
| `gh pr create --draft` | corpo com o template de PR; `--draft` até o CI ficar verde |
| `gh pr ready` | promove draft para revisão, quando o dono autorizar |
| `gh pr view` / `gh pr checks` | leitura livre |

**Proibido**, sem exceção:

- `commit` ou `push` em `main`; `push --force`/`--force-with-lease`; `git reset --hard` em commit já publicado.
- `--no-verify`, `-n`, ou pular hooks.
- `git commit --amend` seguido de `push` quando o commit **já foi empurrado**. `--amend` reescreve o
  histórico e o `push` seguinte exigiria `--force`, que é proibido: correção de commit publicado se
  faz com **commit novo**. `--amend` continua válido em commit ainda local.
- `gh pr merge`, `gh pr close`, apagar branch remota, criar/editar tags ou releases.
- `git add -A` sem antes rodar `git status` e conferir a lista; `git add .` em diretório com build.
- Commitar `.env`, `*.pem`, `*.tfstate*`, `node_modules/`, `dist/`, `coverage/` — o `.gitignore` cobre, mas o `git status` é a última checagem.
- Escrever segredo em mensagem de commit, corpo de PR, comentário de issue ou nome de branch.

> **Única exceção — o commit inicial do repositório.** O primeiro commit (bootstrap) pode ir em
> `main`, porque não existe branch de onde partir e um PR de `main` para `main` é inválido. Vale
> **só** para o commit que cria o repositório; do segundo em diante, tudo por branch e PR.

**Rede indisponível:** se o `push` ou o `gh` falharem por falta de internet, o agente **para**, não
alega sucesso e entrega ao dono o bloco exato de comandos a executar. Nunca inventar URL de PR.

## Commits: Conventional Commits

Formato internacional, em **inglês**, mensagem imperativa e minúscula:

```
<type>(<scope>): <description>
```

- `<type>`: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- `<scope>`: opcional e curto — `api`, `web`, `ranking`, `catalog`, `llm`, `infra`, `deps`, `docs`, `tracker`.
- `<description>`: ≤ 72 caracteres no total da primeira linha, sem ponto final, sem "this commit".
- Corpo (opcional, após uma linha em branco): **por que**, não o quê. Rodapé para `Refs: #12`.
- Um commit = uma mudança lógica. Não misture refactor com feature nem formatação com correção.

Exemplos válidos:

```
feat(api): add POST /api/v1/search endpoint
fix(ranking): treat missing installs as neutral instead of zero
docs(app): record NestJS decision in ADR-007
chore(deps): pin @nestjs/throttler to 6.x
```

Inválidos: `Fix bug`, `ajustes`, `feat: Fixed the bug.`, `update stuff`, `WIP`.

## Issues: a interface do trabalho

O tracker é o GitHub Issues deste repositório. Índice em `tasks/plan.md`; dados em
`scripts/github/tracker.json`; corpos em `scripts/github/issues/f0–f6.md` e `f2-web.md`; publicação
por `scripts/github/publish-tracker.ps1` (`-ValidateOnly` confere a consistência sem rede, `-Apply`
publica).

Toda issue declara:

1. **Milestone** — uma das sete: `F0` pré-requisitos · `F1` proposta e decisões · `F2` aplicação ·
   `F3` infraestrutura como código · `F4` pipeline CI/CD · `F5` observabilidade e segredos ·
   `F6` entrega.
2. **Labels** — exatamente uma de cada eixo: `type:` (`feat`/`fix`/`chore`/`docs`/`test`/`infra`/`gate`),
   `area:` (`api`/`web`/`infra`/`docs`/`observability`/`security`) e `priority:` (`p0`/`p1`/`p2`).
3. **Critérios de aceitação verificáveis** — cada um com o comando que prova (`curl`, `pnpm …`,
   `jq`, `grep`) e a evidência esperada. "Funciona" não é critério.
4. **Verificação** — o bloco de comandos que o revisor e o CI rodam.
5. **Dependências** — a issue ou o gate que precisa fechar antes.

Regras: **uma sub-fase = uma issue** (F2.1, F2.2, …). Issue de `backend/` e issue de `frontend/` da
mesma entrega ficam na **mesma milestone** e se referenciam por título na linha **"Pareia com:"**.
O corpo vive em `scripts/github/issues/fN.md`, entre marcadores `<!--ISSUE:título-->`, com as seções
`## O que entrega`, `## Critérios de aceitação`, `## Verificação`, `## Dependências`,
`## Referência`. `.github/ISSUE_TEMPLATE/` não existe ainda: abrir issue pela web exige copiar
essas seções **e** acrescentar a entrada em `tracker.json` — senão o índice de `tasks/plan.md`
passa a mentir.

## Pull request

```bash
gh pr create --draft --base main --title "feat(api): add search endpoint" --body-file .github/pull_request_template.md
```

Corpo obrigatório (o template já traz as seções):

1. **What** — a mudança em 2–4 linhas.
2. **Why** — o requisito que ela atende (cite `docs/app/...` ou `US-nn`).
3. **Evidence** — comandos rodados e a saída relevante.
4. **Risks** — o que pode quebrar; o que ficou de fora.
5. **Checklist** — testes, lint, sem segredo, sem arquivo gerado.

Título segue o mesmo Conventional Commits. Nunca PR de `main` para `main`, nunca com CI vermelho
conhecido, nunca com segredo no diff. Merge é decisão do dono.

## Documentação da API

- O contrato é `openapi.yaml`, **gerado** pelos decorators do `@nestjs/swagger`:
  `pnpm --dir backend openapi:generate`. O arquivo versionado e o gerado não podem divergir — a
  verificação é `git diff --exit-code openapi.yaml` depois de gerar.
- A UI de referência é o **Scalar** (`@scalar/nestjs-api-reference`) em `/docs`, com o Swagger JSON
  em `/docs-json`. Swagger UI **não** é a interface padrão.
- Mudança de campo, de código de erro ou de endpoint é mudança de contrato: mesma milestone do
  frontend e revisão do `reviewer`.

## Onde está o quê

| Preciso de… | Vá para |
| --- | --- |
| Vocabulário do domínio, invariantes e mapa das pastas | `CONTEXT.md` |
| Produto, histórias de usuário, regra de ranking | `docs/app/01-spec-produto.md` |
| Componentes, contrato da API, modelo de dados, segurança, ADRs | `docs/app/02-arquitetura.md` |
| O que construir agora, sub-fases F2.0–F2.10, gates | `docs/app/03-plano-app.md` |
| Índice das issues por milestone e riscos | `tasks/plan.md` |
| Fases do projeto acadêmico (EC2, Terraform, CI/CD, demo) | `docs/04-plano-de-execucao.md` |
| Requisitos e pesos do professor | `docs/00-edital-projeto-2.md` |
| Limites do sandbox AWS Academy | `docs/02-aws-academy-limites-e-riscos.md` |
| Decisão sobre a fonte de dados do skills.sh e amostra real | `docs/app/amostras/README.md` |

## Stack (decidida em 2026-11-14, ADR-007 em `docs/app/02-arquitetura.md`)

| Camada | Escolha |
| --- | --- |
| Backend | **NestJS 11** + TypeScript strict, `pnpm`, `@nestjs/swagger`, `class-validator` |
| Banco | PostgreSQL 16, **Prisma** (migrations + `$queryRaw` para FTS/`pg_trgm`) |
| Frontend | React 18 + Vite + TypeScript |
| Testes | Jest + Supertest (`backend`), Vitest (`frontend`), `nock` para isolar rede |
| Borda | nginx (SPA + proxy `/api`) |
