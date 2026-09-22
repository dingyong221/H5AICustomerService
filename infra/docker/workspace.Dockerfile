# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain

ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable \
  && corepack prepare pnpm@11.19.0 --activate

WORKDIR /workspace

FROM toolchain AS build

ARG APP_KIND
ARG APP_NAME
ARG NEXT_PUBLIC_APP_ENV=production
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ARG NEXT_PUBLIC_MERCHANT_API_BASE_URL=/api/v1
ARG NEXT_PUBLIC_PUBLIC_API_BASE_URL=/api/v1/public

ENV NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_MERCHANT_API_BASE_URL=${NEXT_PUBLIC_MERCHANT_API_BASE_URL}
ENV NEXT_PUBLIC_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_PUBLIC_API_BASE_URL}

COPY . .

RUN case "${APP_KIND}:${APP_NAME}" in \
      api:api|worker:worker|web:merchant-web|web:consumer-h5|web:ops-web) ;; \
      *) echo "Unsupported APP_KIND/APP_NAME pair: ${APP_KIND}:${APP_NAME}" >&2; exit 64 ;; \
    esac

RUN --mount=type=cache,id=h5cs-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

RUN pnpm exec turbo run build --filter="./apps/${APP_NAME}" \
  && pnpm --filter "./apps/${APP_NAME}" --prod deploy --legacy /opt/deployed-app

FROM node:${NODE_VERSION}-bookworm-slim AS runtime-base

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /opt/deployed-app/ ./

USER node

FROM runtime-base AS api

ENV HOST=0.0.0.0
ENV PORT=4000

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '4000') + '/livez').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/main.js"]

FROM runtime-base AS worker

ENV WORKER_HEALTH_HOST=0.0.0.0
ENV WORKER_HEALTH_PORT=3011

EXPOSE 3011

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.WORKER_HEALTH_PORT || '3011') + '/livez').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/main.js"]

FROM runtime-base AS web

ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HEALTHCHECK_PATH=/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + (process.env.HEALTHCHECK_PATH || '/')).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "node_modules/next/dist/bin/next", "start"]
