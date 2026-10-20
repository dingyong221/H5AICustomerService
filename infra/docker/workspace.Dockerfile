# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS toolchain

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
ARG NEXT_PUBLIC_MERCHANT_BASE_PATH=
ARG NEXT_PUBLIC_MERCHANT_ASSET_PREFIX=
ARG NEXT_PUBLIC_OPS_BASE_PATH=

ENV NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV}
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_MERCHANT_API_BASE_URL=${NEXT_PUBLIC_MERCHANT_API_BASE_URL}
ENV NEXT_PUBLIC_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_PUBLIC_API_BASE_URL}
ENV NEXT_PUBLIC_MERCHANT_BASE_PATH=${NEXT_PUBLIC_MERCHANT_BASE_PATH}
ENV NEXT_PUBLIC_MERCHANT_ASSET_PREFIX=${NEXT_PUBLIC_MERCHANT_ASSET_PREFIX}
ENV NEXT_PUBLIC_OPS_BASE_PATH=${NEXT_PUBLIC_OPS_BASE_PATH}

COPY . .

RUN case "${APP_KIND}:${APP_NAME}" in \
      api:api|worker:worker|web:merchant-web|web:consumer-h5|web:ops-web) ;; \
      *) echo "Unsupported APP_KIND/APP_NAME pair: ${APP_KIND}:${APP_NAME}" >&2; exit 64 ;; \
    esac

RUN --mount=type=cache,id=h5cs-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

RUN pnpm exec turbo run build --filter="./apps/${APP_NAME}" \
  && pnpm --config.inject-workspace-packages=true --filter "./apps/${APP_NAME}" --prod deploy /opt/deployed-app \
  && if [ "${APP_KIND}" = api ]; then \
       test -f /opt/deployed-app/node_modules/@h5cs/database/dist/config.js \
       && inventory="$(node /opt/deployed-app/node_modules/@h5cs/database/scripts/migrate-managed.mjs --inventory)" \
       && printf '%s' "$inventory" | node -e 'const value = JSON.parse(require("node:fs").readFileSync(0, "utf8")); if (value.dialect !== "mysql" || !Array.isArray(value.entries) || value.entries.length === 0 || !/^[0-9a-f]{64}$/.test(value.planSha256)) process.exit(1);'; \
     fi

# Pre-extract bundled PDFium to retain a non-root/read-only/noexec-temp runtime.
RUN if [ "${APP_NAME}" = merchant-web ]; then \
      mkdir -p /opt/deployed-app/parser-runtime \
      && TMPDIR=/opt/deployed-app/parser-runtime node /opt/deployed-app/scripts/warm-material-parser.mjs \
      && test -s /opt/deployed-app/parser-runtime/kreuzberg-pdfium/libpdfium.so; \
    fi

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime-base

ENV NODE_ENV=production
LABEL org.opencontainers.image.source="https://github.com/dingyong221/H5AICustomerService"

WORKDIR /app

COPY --from=build --chown=node:node /opt/deployed-app/ ./

RUN if [ -d /app/parser-runtime ]; then \
      chown -R root:root /app/parser-runtime && chmod -R a-w /app/parser-runtime; \
    fi

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

ARG NEXT_PUBLIC_MERCHANT_BASE_PATH=
ARG NEXT_PUBLIC_MERCHANT_ASSET_PREFIX=
ARG NEXT_PUBLIC_OPS_BASE_PATH=

ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV HEALTHCHECK_PATH=/
ENV NEXT_PUBLIC_MERCHANT_BASE_PATH=${NEXT_PUBLIC_MERCHANT_BASE_PATH}
ENV NEXT_PUBLIC_MERCHANT_ASSET_PREFIX=${NEXT_PUBLIC_MERCHANT_ASSET_PREFIX}
ENV NEXT_PUBLIC_OPS_BASE_PATH=${NEXT_PUBLIC_OPS_BASE_PATH}

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + (process.env.HEALTHCHECK_PATH || '/')).then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "node_modules/next/dist/bin/next", "start"]
