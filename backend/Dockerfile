# syntax=docker/dockerfile:1
# Estágios: base -> deps -> (dev | build) -> prod-deps -> runtime.
# Nenhum segredo em ENV/ARG: tudo entra por variável de ambiente em runtime.
#
# pnpm: corepack com a MESMA versão de `packageManager` (package.json: pnpm@12.21.0)
# em TODOS os estágios, inclusive no runtime. `corepack install -g` baixa o pnpm no
# build e o deixa no `COREPACK_HOME` fixo, então o dev não resolve versão (nem rede)
# no start e não depende do HOME do usuário.
#
# O runtime é a exceção: ali o pnpm não roda script nenhum. O `corepack install`
# instala só o wrapper (sem lifecycle script e sem o `@pnpm/exe.*`), e o pnpm 12
# re-resolve as dependências do projeto — e reinstala `node_modules` — antes de
# executar um script, o que um `/app` somente leitura com uid 10001 não permite
# (`make migrate` no dev continua pnpm: lá o lockfile está no lugar e `/app` é
# gravável). A migração de produção é `npm run --silent prisma:deploy`, um comando
# `node` sobre o CLI do Prisma, que é dependency; `scripts/dev/prisma-runtime-check.sh`
# cobre o caminho na imagem `runtime`.

FROM node:22-alpine AS base
WORKDIR /app
# openssl/libc6-compat: engine do Prisma em musl.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apk add --no-cache libc6-compat openssl \
    && corepack enable \
    && corepack install -g pnpm@12.21.0 \
    && chmod -R a+rX "${COREPACK_HOME}"

FROM base AS deps
# `pnpm-workspace.yaml` carrega o `allowBuilds`: sem ele o install dentro da imagem
# roda sem a allowlist revisada, e a política do host não vale no build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--frozen-lockfile`: sem `pnpm-lock.yaml` o build falha aqui, em vez de resolver
# centenas de transitivas sem auditoria. Gere o lock com `make bootstrap` e
# commite antes do primeiro build com credencial real (backend/README.md).
RUN pnpm install --frozen-lockfile

# Profile `dev` do compose: devDependencies + `nest start --watch`.
FROM deps AS dev
ENV NODE_ENV=development
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# `scripts/` traz o `seed.ts` (`make seed`) e o gerador do OpenAPI. Só no estágio
# de dev: o runtime não executa nenhum dos dois.
COPY scripts ./scripts
RUN pnpm prisma generate
EXPOSE 8000
CMD ["pnpm", "start:dev"]

FROM deps AS build
COPY prisma ./prisma
RUN pnpm prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build

# node_modules sem devDependencies, em estágio próprio. Mesmo efeito de
# `pnpm deploy --prod` (que exige workspace) ou de `pnpm prune --prod`, mas
# resolvido a partir do lock num diretório limpo. O client do Prisma é regerado
# aqui para não depender de sobras do node_modules de build.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile \
    && pnpm prisma generate

FROM base AS runtime
ENV NODE_ENV=production
RUN addgroup --system --gid 10001 app \
    && adduser --system --uid 10001 --ingroup app app
WORKDIR /app
COPY --from=prod-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=prod-deps --chown=10001:10001 /app/prisma ./prisma
COPY --chown=10001:10001 package.json ./
USER 10001
EXPOSE 8000
CMD ["node", "dist/main.js"]
