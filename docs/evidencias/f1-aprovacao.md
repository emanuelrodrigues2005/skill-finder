# F1 — Proposta e decisões

**Data:** 2026-11-15
**Gate de origem:** `docs/04-plano-de-execucao.md` §8/F1 e edital §6.1 (entregável E1)
**Issue:** `Obter aprovação do professor para a proposta E1` (milestone F1)

## Situação

A proposta foi **aprovada**, incluindo o tema escolhido: um **recomendador de skills de agentes**
— o usuário descreve a necessidade em linguagem natural e recebe uma lista ordenada e explicada de
skills do catálogo do skills.sh.

| Item | Decisão |
| --- | --- |
| Tema | **Aprovado** — recomendação/descoberta de skills de agentes (o "Tema D" registrado em `docs/app/01-spec-produto.md` §7.3) |
| Problema | Descrever em linguagem natural a skill necessária e receber uma lista curta, ordenada e explicada |
| Funcionalidades | Busca em linguagem natural, filtro por categoria, ranking determinístico, explicação por item, detalhe com `SKILL.md`, permalink do histórico |
| Arquitetura preliminar | EC2 única + Docker Compose (Opção 1), ECR para imagens, `tfstate` no S3, Infisical para segredos — `docs/01` §5.1 |
| Tecnologias | NestJS 11 + TypeScript + Prisma/PostgreSQL 16; React 18 + Vite; nginx na borda; Terraform ≥ 1.10; GitHub Actions (ADR-007) |

## Escopo congelado

**Dentro:** as 5 histórias centrais (`US-01`, `US-04`, `US-05`, `US-06`, `US-07`) mais `US-08`
(degradação) e `US-11` (limites de uso) — descritas em `docs/app/01-spec-produto.md` §4.

**Fora de escopo (v1):** instalação da skill pelo produto; autenticação de usuário; embeddings e
busca vetorial; multi-idioma na interface; dashboard administrativo; notificação por e-mail.

## Regra não trivial

**A ordem da lista não é decidida pela LLM.** Ela interpreta a intenção e redige o porquê; o `score`
sai de uma função pura do backend (`docs/app/01-spec-produto.md` §5), com pesos em configuração e
desempate total. Isso é o que torna a resposta auditável e repetível.

## Perguntas abertas herdadas

Q1–Q6 de `docs/app/02-arquitetura.md` §11 seguem em aberto, com os padrões já adotados registrados
em `docs/04-plano-de-execucao.md` §12. Nenhuma bloqueia a F2: o contrato (F2.1) é quem as congela.

## Evidência

- Aprovação registrada nesta data, por declaração do dono do projeto ao agente, durante a sessão de
  execução da milestone F1.
- Escopo e arquitetura já formalizados em `docs/app/01-spec-produto.md` e `docs/app/02-arquitetura.md`
  (ADR-001 a ADR-007).
- Gate seguinte liberado: **F2** (aplicação).
