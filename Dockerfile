FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

FROM base AS installer
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
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

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/prisma-engine/query-engine.node /app/prisma-engine/query-engine.node

EXPOSE 8080
ENV HOSTNAME=0.0.0.0

WORKDIR /app/apps/dashboard
CMD ["node", "server.js"]
