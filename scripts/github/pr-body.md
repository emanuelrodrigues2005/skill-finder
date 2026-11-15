## What

Moderniza a toolchain e alinha os builds de container: `packageManager` vai para **pnpm 12.21.0**
nos dois pacotes, a allowlist de scripts de build migra para `pnpm-workspace.yaml` (pnpm 12 deixou de
ler o bloco `pnpm` do `package.json`), os dois `Dockerfile` passam a copiar `pnpm-lock.yaml` +
`pnpm-workspace.yaml` e a instalar com `--frozen-lockfile`. Inclui duas correções encontradas na
primeira execução real do backend (`LLM_ENABLED` defaultando para `false` e o `TS2430` do
interceptor de métricas) e o gate de revisão/execução do `AGENTS.md`.

## Why

Fecha o esqueleto da **F2.2** (`docs/app/03-plano-app.md`) com dependências auditáveis: antes não
havia lockfile, então o build resolvia ~700 pacotes transitivos sem registro. O bug do
`LLM_ENABLED` **enfraquecia o gate de produção** — com `LLM_ENABLED=false` o boot em `ENV=prod`
deixava de exigir `LLM_API_KEY`, o oposto do previsto em `docs/app/02-arquitetura.md` §3.

## Evidence

| Comando | Resultado |
| --- | --- |
| `pnpm --dir backend typecheck` | exit 0 (após corrigir o `TS2430` do `http-metrics.interceptor.ts`) |
| `pnpm --dir backend test` | `Tests: 20 passed, 20 total` (após corrigir o default de `LLM_ENABLED`) |
| `docker compose config -q` | exit 0, com e sem `.env` |
| `docker compose --profile prod config -q` | exit 0, renderiza `ENV: prod` e `target: runtime` |
| `pnpm-lock.yaml` | 700 entradas de `integrity` no backend, 317 no frontend |
| `.env.example` | 22 chaves, **zero** valores |

Ainda **não** anexados, e por isso o PR fica em draft: `test:e2e`, `pnpm --dir frontend build`,
`docker build --target runtime` e a conferência das três autorizações em
`node_modules/.modules.yaml`.

## Risks

- **`allowBuilds` autoriza postinstall de 3 pacotes do Prisma.** É ganho líquido (antes *todos*
  rodavam), mitigado por pin exato `6.2.1` e lock com integridade. Vira inaceitável se uma entrada
  nova entrar em `allowBuilds` sem revisão do lock.
- **`DEV_DEFAULT_DB_PASSWORD = 'skillsdev'`** committado para a árvore limpa validar. Em `ENV=prod`
  o boot recusa esse valor e o Postgres não publica porta, mas um volume inicializado com ele
  precisa ser recriado (`docker compose down -v`).
- **`isolatedModules` só no ts-jest**, não no `tsconfig.json` do build: o `typecheck` cobre o que o
  transpile-only deixaria passar.
- **Ficou de fora**: `400` vs `422` na validação (depende dos DTOs da F2.6), `helmet` (middleware
  cobre nosniff/Referrer/frame + `x-powered-by`), throttler em memória (uma réplica, ADR-006).

## Checklist

- [x] `typecheck` e `test` verdes na máquina do dono
- [x] Nenhum segredo no diff (`git status` conferido arquivo a arquivo)
- [x] Nenhum arquivo gerado commitado (`node_modules/`, `dist/`, `coverage/`, `.env`)
- [x] Revisado pelos presets `reviewer` e `security` (dois APPROVE)
- [ ] `test:e2e` anexado
- [ ] `docker build` das duas imagens anexado
- [ ] `openapi.yaml` gerado (F2.1) — fora do escopo deste PR
