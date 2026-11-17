FROM node:22-alpine AS builder

WORKDIR /app

# Alinhado ao backend/Dockerfile: pnpm fixado pelo `packageManager` e instalado no
# `COREPACK_HOME` da imagem, para o build não resolver versão nem depender do HOME.
ENV COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack install -g pnpm@12.21.0 \
    && chmod -R a+rX "${COREPACK_HOME}"

# `pnpm-workspace.yaml` traz o `allowBuilds` (esbuild do Vite). `--frozen-lockfile`
# faz o build falhar alto se o lock divergir do manifesto, em vez de resolver novas
# versões sem auditoria.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src

RUN pnpm build

FROM nginx:1.27-alpine AS runtime

# `nginx:1.27-alpine` é BusyBox: `groupadd`/`useradd` (style Debian) não existem —
# usar `addgroup`/`adduser` com as flags equivalentes:
#   -S  usuário/grupo de sistema (sem entrada de senha)
#   -D  sem senha
#   -H  sem home
#   -G  grupo primário
RUN rm -f /etc/nginx/conf.d/default.conf \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S -D -H -G app -s /sbin/nologin app \
    && chown -R 10001:10001 /var/cache/nginx /var/log/nginx

COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=builder --chown=10001:10001 /app/dist /usr/share/nginx/html

USER 10001

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
