FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*

FROM base AS workspace
WORKDIR /work
RUN npm install --global pnpm@11.25.0 --no-audit --no-fund
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/sdk/package.json packages/sdk/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/prisma.config.ts ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY apps/api/src ./apps/api/src
RUN pnpm db:generate && pnpm -C apps/api build

FROM base AS migration
WORKDIR /work/apps/api
COPY --from=workspace /work/node_modules /work/node_modules
COPY --from=workspace /work/apps/api/node_modules ./node_modules
COPY apps/api/package.json apps/api/prisma.config.ts ./
COPY apps/api/prisma ./prisma
COPY infra/container/database.mjs infra/container/migrate.mjs infra/container/maintenance.sql ./ops/
CMD ["node", "ops/migrate.mjs"]

FROM workspace AS production-dependencies
RUN rm -rf /work/node_modules /work/apps/api/node_modules /work/apps/web/node_modules /work/packages/sdk/node_modules \
    && pnpm --filter @mns-suporte/api install --prod --frozen-lockfile --offline \
    && test ! -e /work/apps/api/node_modules/prisma

FROM base AS api
WORKDIR /work/apps/api
ARG MNS_IMAGE_RELEASE=unrecorded
LABEL org.opencontainers.image.version=$MNS_IMAGE_RELEASE
ENV NODE_ENV=production
COPY --from=production-dependencies /work/node_modules /work/node_modules
COPY --from=production-dependencies /work/apps/api/node_modules ./node_modules
COPY --from=workspace /work/apps/api/dist ./dist
COPY apps/api/package.json ./package.json
COPY infra/container/database.mjs infra/container/start-api.mjs infra/container/maintenance.mjs ./ops/
USER node
CMD ["node", "--env-file=/run/secrets/api_env", "ops/start-api.mjs"]
