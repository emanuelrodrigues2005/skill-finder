# Skill Finder — API (NestJS 11)

Backend do Skill Finder: esqueleto da F2.2 (saúde, métricas, configuração e
migrations). Sem domínio ainda — `search`, `catalog` e `llm` entram nas F2.3–F2.6.

Contrato de referência: `docs/app/02-arquitetura.md` §3 (env), §4.1 (modelo de
dados), §5 (API), §9 (métricas e log).

## Rodar local

```bash
pnpm install            # exige rede
pnpm prisma:generate
pnpm start:dev          # http://127.0.0.1:8000
```

Ou tudo pelo compose, na raiz do monorepo: `make bootstrap` (gera o lock) e depois
`make up` (profile `dev`).

## Lockfile (`pnpm-lock.yaml`)

O lock é gerado por `pnpm install` na máquina do dono (`make bootstrap`) e **precisa
ser commitado antes do primeiro build com credencial real**. O `Dockerfile` instala
com `pnpm install --frozen-lockfile`: sem o lock o build falha de propósito, em vez
de resolver centenas de dependências transitivas sem auditoria. `openapi.yaml`
também só pode ser gerado depois do `pnpm install` (o script roda com `ts-node`).

## Scripts

| Script | O que faz |
| --- | --- |
| `build` | `nest build` (tsc → `dist/`) |
| `start` | roda `dist/main.js` |
| `start:dev` | `nest start --watch` |
| `lint` / `format` | ESLint 9 (flat) / Prettier |
| `test` / `test:e2e` | Jest unitário (inclui `test/env.spec.ts` e `test/log-redaction.spec.ts`) / Jest + Supertest |
| `typecheck` | `tsc --noEmit` |
| `prisma:generate` | gera o Prisma Client |
| `prisma:migrate` | `prisma migrate dev` (dev, com banco no ar) |
| `prisma:deploy` | `prisma migrate deploy` (CI/prod) |
| `openapi:generate` | escreve `openapi.yaml` na raiz do monorepo (exige `node_modules`) |

## Endpoints da fase

- `GET /healthz` — liveness, sem dependência.
- `GET /readyz` — `SELECT 1` no Postgres; `503` com `error.code = NOT_READY` e
  `details.dependency = "postgres"` quando o banco não responde.
- `GET /metrics` — Prometheus (`http_requests_total`, `http_request_duration_seconds`).

Os três ficam **fora** de `/api/v1` (prefixo global). Swagger em `/docs` só fora de
`ENV=prod`; `/api/v1` nasce na F2.6.

## Decisões de estrutura

- **Uma porta de configuração.** `src/config/env.schema.ts` (zod) é o único lugar que
  lê `process.env`; `AppConfigService` valida no boot e falha em `ENV=prod` sem
  `DATABASE_URL`, sem `LLM_API_KEY` (com `LLM_ENABLED=true`) ou sem `IP_HASH_SALT`.
  Também recusa `NODE_ENV=production` com `ENV!=prod`: a imagem de runtime nasce com
  `NODE_ENV=production`, então "prod em modo dev" é bug, não preferência. String
  vazia vale como ausente, então `.env.example` copiado não quebra os defaults.
- **`/readyz` falha com o banco fora, mas a API sobe.** O `PrismaService` tenta
  conectar no `onModuleInit` e só loga: quem decide reinício é o orquestrador, e a
  readiness é quem reporta o 503.
- **Erros num envelope só.** `HttpExceptionFilter` traduz qualquer exceção para
  `{request_id, error: {code, message, details}}` (§5.5); stack trace vai para o log.
  `ValidationPipe` usa `exceptionFactory` para devolver `422 VALIDATION_ERROR` com
  `details.fields`.
- **Métricas no interceptor.** `http_requests_total{route,method,status}` e
  `http_request_duration_seconds{route,method}` usam o template da rota
  (`/skills/:skill_id`), nunca a URL concreta — cardinalidade controlada. `/metrics`
  e `/healthz` ficam **fora** da medição: são chamados em loop (scrape e
  healthcheck) e inflariam o próprio counter.
- **Imagem em estágios.** `dev` (com devDependencies + hot reload, profile `dev`) e
  `runtime` (só produção, profile `prod`); o `compose.yaml` escolhe por `target:`.
  O `node_modules` de produção vem de um `pnpm install --prod --frozen-lockfile`
  próprio, então o runtime não carrega devDependencies. `prisma` fica em
  `dependencies` porque o runtime roda `pnpm prisma:deploy` (`make migrate`).
- **Headers e proxy.** `X-Content-Type-Options`, `Referrer-Policy` e
  `X-Frame-Options` saem de um middleware (a API só serve JSON; o CSP da SPA é do
  nginx) e `trust proxy` é 1, o salto do nginx: `req.ip` não vem de um
  `X-Forwarded-For` forjado pelo cliente.
- **Migrations.** `prisma/migrations/` está vazio de propósito: a migration inicial
  precisa de um Postgres vivo. Os pontos que o Prisma não expressa (`CHECK`,
  `tsvector`/GIN, `pg_trgm`, índice único parcial do lock de ingestão) entram como
  SQL na migration, na ordem documentada no cabeçalho de `prisma/schema.prisma`
  (`CREATE EXTENSION pg_trgm` **antes** do índice `gin_trgm_ops`) e transcritos em
  `prisma/migrations/README.md`.
- **Aliases `@/`.** Declarados no `tsconfig.json` e mapeados no Jest; o código de
  runtime usa imports relativos para `node dist/main.js` funcionar sem loader extra.
