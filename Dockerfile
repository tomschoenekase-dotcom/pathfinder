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
RUN pnpm --filter @pathfinder/dashboard build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/dashboard/.next/standalone ./
COPY --from=builder /app/apps/dashboard/.next/static ./apps/dashboard/.next/static
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/*.node ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/*.node ./apps/dashboard/.next/server/

EXPOSE 8080
ENV HOSTNAME=0.0.0.0

WORKDIR /app/apps/dashboard
CMD ["node", "server.js"]
