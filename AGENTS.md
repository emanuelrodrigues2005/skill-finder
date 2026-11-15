# AGENTS.md — Skill Finder (Projeto 2)

O usuário descreve, em linguagem natural, a skill de agente que precisa; a aplicação interpreta o
pedido com uma LLM, consulta o catálogo do site **skills.sh** e devolve uma lista **ranqueada e
explicada**. Monorepo: `backend/` (NestJS + TypeScript), `frontend/` (React + Vite + TypeScript),
`docs/` (spec, arquitetura, planos), `infra/` (Terraform, a partir da F3).

Este arquivo é a regra que vale em toda sessão. O resto está nos documentos apontados na tabela
ao final.

## Comandos

Fonte de verdade: `Makefile` (`make up`, `down`, `logs`, `migrate`, `seed`, `test`, `lint`,
`config`). Dentro de `backend/` e `frontend/`, o gerenciador é **pnpm**.

Sem internet nesta máquina, `pnpm install` falha — instale quando houver rede.

## Regras que não se deduzem do código

1. **O ranking é determinístico.** A ordem sai de `backend/src/ranking`, uma função pura: sem
   I/O, sem `Math.random`, sem relógio. A LLM interpreta a intenção e redige o *porquê*; ela nunca
   escolhe a ordem, nunca produz `score`, nunca cita uma skill fora do conjunto já recuperado.
2. **Texto externo é dado não confiável.** `SKILL.md`, resumo e a consulta do usuário entram
   delimitados e apenas na mensagem de usuário — nunca no *system prompt*. A saída é validada
   contra schema e campo fora do schema é descartado.
3. **Dado ausente é `null`, jamais zero.** `evidence_completeness` marca o item incompleto e a
   interface mostra `n/a`.
4. **A chave da LLM vive só no backend.** O navegador fala apenas com `/api/v1`; nenhuma chamada
   direta ao provedor, nenhuma chave no bundle.
5. **Nenhum teste abre socket.** `nock.disableNetConnect()` no setup do Jest; catálogo vem de
   `backend/test/fixtures/`; `LLM_PROVIDER=fake` é o padrão de `dev` e de CI.
6. **Interface em inglês, documentação em português.**
7. **Degradação é visível.** Com a LLM fora do ar, a resposta traz `degraded: true` e a intenção
   vem do fallback por palavras-chave — a tela nunca mostra lista vazia sem explicação.

## Git: o que o agente pode fazer

**Permitido**, sempre em branch de trabalho (nunca direto em `main`):

| Operação | Condição |
| --- | --- |
| `git switch -c <branch>` | nome no padrão `<type>/<escopo-curto>` (ex.: `feat/nest-backend`) |
| `git add` + `git commit` | somente com o gate de revisão abaixo cumprido |
| `git push -u origin <branch>` | somente branch próprio, nunca `main` |
| `gh pr create --draft` | corpo com o template abaixo; `--draft` até o CI ficar verde |
| `gh pr view` / `gh pr checks` | leitura livre |

**Proibido**, sem exceção:

- `commit` ou `push` em `main`; `push --force`/`--force-with-lease`; `git reset --hard` em commit já publicado.
- `--no-verify`, `-n`, ou pular hooks; `git commit --amend` em commit já enviado.
- `gh pr merge`, `gh pr close`, apagar branch remota, criar/editar tags ou releases.
- `git add -A` sem antes rodar `git status` e conferir a lista; `git add .` em diretório com build.
- Commitar `.env`, `*.pem`, `*.tfstate*`, `node_modules/`, `dist/`, `coverage/` — o `.gitignore` cobre, mas o `git status` é a última checagem.
- Escrever segredo em mensagem de commit, corpo de PR, comentário de issue ou nome de branch.

> **Única exceção — o commit inicial do repositório.** O primeiro commit (bootstrap) pode ir em
> `main`, porque não existe branch de onde partir e um PR de `main` para `main` é inválido. Vale
> **só** para o commit que cria o repositório; do segundo em diante, tudo por branch e PR.

**Rede indisponível:** se o `push` ou o `gh` falharem por falta de internet, o agente **para**, não
alega sucesso e entrega ao dono o bloco exato de comandos a executar. Nunca inventar URL de PR.

## Gate de revisão antes de commitar

Nenhum commit sem revisão por **outro** preset — quem escreveu não aprova o próprio trabalho.

| Tipo de mudança | Revisor obrigatório | O que ele verifica |
| --- | --- | --- |
| Código em `backend/` ou `frontend/` | `reviewer` | diff completo, aderência ao `docs/app/02-arquitetura.md`, testes, nomes, dead code |
| Testes novos ou alterados | `tester` | os testes falham sem a mudança e passam com ela; nada de teste que sempre passa |
| Auth, segredos, `LLM_API_KEY`, CORS, rate limit, prompt, dependências | `security` **em adição** ao `reviewer` | vazamento de chave, superfície de injeção, permissões, dependência nova justificada |
| `docs/` apenas | dispensado | — |

O revisor recebe o **diff** e os **comandos de verificação com a saída**; sem saída de comando,
o gate não fecha. Se o revisor pedir ajuste, o autor corrige e pede nova revisão — no máximo duas
idas e voltas; na terceira, o agente para e reporta o bloqueio ao dono.

## Commits: Conventional Commits

Formato internacional, em **inglês**, mensagem imperativa e minúscula:

```
<type>(<scope>): <description>
```

- `<type>`: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- `<scope>`: opcional e curto — `api`, `web`, `ranking`, `catalog`, `llm`, `infra`, `deps`, `docs`.
- `<description>`: ≤ 72 caracteres no total da primeira linha, sem ponto final, sem "this commit".
- Corpo (opcional, após uma linha em branco): **por que**, não o quê. Rodapé para `Refs: #12` ou `BREAKING CHANGE: …`.
- Um commit = uma mudança lógica. Não misture refactor com feature nem formatação com correção.

Exemplos válidos:

```
feat(api): add POST /api/v1/search endpoint
fix(ranking): treat missing installs as neutral instead of zero
fix: prevent expired lab token from crashing startup
docs(app): record NestJS decision in ADR-007
chore(deps): pin @nestjs/throttler to 6.x
```

Inválidos (não use): `Fix bug`, `ajustes`, `feat: Fixed the bug.`, `update stuff`, `WIP`, `feat: ...` sem escopo quando o escopo é óbvio.

## Pull request

```bash
gh pr create --draft --base main --title "feat(api): add search endpoint" --body-file .github/pull_request_template.md
```

Corpo obrigatório (o template já traz as seções):

1. **What** — a mudança em 2–4 linhas.
2. **Why** — o requisito que ela atende (cite `docs/app/...` ou `US-nn`).
3. **Evidence** — comandos rodados e a saída relevante (`pnpm test`, `make config`, `curl`).
4. **Risks** — o que pode quebrar; o que ficou de fora.
5. **Checklist** — testes, lint, sem segredo, sem arquivo gerado.

Título do PR segue o mesmo Conventional Commits. Nunca abrir PR de `main` para `main`, nunca com
CI vermelho conhecido, nunca com segredo no diff.

## Onde está o quê

| Preciso de… | Vá para |
| --- | --- |
| Produto, histórias de usuário, regra de ranking | `docs/app/01-spec-produto.md` |
| Componentes, contrato da API, modelo de dados, segurança | `docs/app/02-arquitetura.md` |
| O que construir agora, sub-fases F2.0–F2.9, gates | `docs/app/03-plano-app.md` |
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
| Testes | Jest + Supertest (`backend`), Vitest (quando houver, `frontend`), `nock` para isolar rede |
| Borda | nginx (SPA + proxy `/api`) |
