<!--
Título do PR: mesmo formato dos commits — `<type>(<scope>): <description>` em inglês.
Abra como draft (`gh pr create --draft`) e só marque pronto com CI verde.
Nunca faça merge: merge é do dono do repositório.
-->

## What

<!-- 2–4 linhas: o que muda, em inglês ou português, direto ao ponto. -->

## Why

<!-- O requisito que isso atende. Cite `docs/app/01-spec-produto.md` US-nn,
     `docs/app/02-arquitetura.md` §n ou `docs/app/03-plano-app.md` F2.n.
     Se não houver requisito, diga por que a mudança é necessária. -->

## Evidence

<!-- Comandos realmente executados e a saída relevante. Sem isso o PR não fecha o gate
     de revisão (AGENTS.md). Exemplo:

```
$ pnpm --dir backend test
PASS src/ranking/ranking.spec.ts
Tests: 12 passed, 12 total

$ docker compose config -q
exit 0
```
-->

## Risks

<!-- O que pode quebrar, o que ficou de fora, o que precisa de atenção do revisor. -->

## Checklist

- [ ] `pnpm lint` e `pnpm test` verdes (cole a saída em Evidence)
- [ ] `pnpm --dir backend exec tsc --noEmit` sem erro
- [ ] nenhum segredo no diff: `git diff --cached | grep -iE 'sk-|password=|BEGIN .*PRIVATE'` vazio
- [ ] nenhum arquivo gerado versionado (`node_modules/`, `dist/`, `coverage/`, `.env`)
- [ ] se a API mudou, `openapi.yaml` regenerado e `docs/app/02-arquitetura.md` §5 atualizado
- [ ] revisão de outro preset registrada (reviewer; `security` quando toca segredo/auth/deps)
