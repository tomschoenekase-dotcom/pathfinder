FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS installer
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=4096
ARG NEXT_PUBLIC_WEB_URL
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_AFTER_SIGN_OUT_URL
COPY --from=installer /app ./
RUN pnpm --filter @pathfinder/db exec prisma generate
RUN pnpm characters:sync
RUN pnpm --filter @pathfinder/dashboard build
RUN mkdir -p /app/prisma-engine \
  && cp /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node /app/prisma-engine/query-engine.node

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/prisma-engine/query-engine.node
RUN apk add --no-cache fontconfig

COPY --from=builder --chown=node:node /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder --chown=node:node /app/prisma-engine/query-engine.node /app/prisma-engine/query-engine.node
RUN mkdir -p /app/packages/api/node_modules \
  && ln -s ../../../apps/dashboard/node_modules/sharp /app/packages/api/node_modules/sharp
COPY --from=builder --chown=node:node /app/packages/api/assets/fonts /usr/share/fonts/torchiko
RUN fc-cache -f

EXPOSE 8080
ENV HOSTNAME=0.0.0.0

WORKDIR /app/apps/dashboard
USER node
CMD ["node", "server.js"]
