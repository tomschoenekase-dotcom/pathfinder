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
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
RUN pnpm --filter @pathfinder/admin build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/admin/.next/standalone ./
COPY --from=builder /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/*.node ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/*.node ./apps/admin/.next/server/
# Railway's stale UI start command is: cd /app/apps/dashboard && node server.js
# The shell built-in cd runs (our /usr/local/bin/cd shim is bypassed by shells).
# Fix: create /app/apps/dashboard with a server.js that boots the real admin server,
# so the Railway command succeeds without any shim at all.
RUN mkdir -p /app/apps/dashboard
COPY apps/admin/docker/server-compat.js /app/apps/dashboard/server.js
COPY apps/admin/docker/server-compat.js /app/apps/admin/server.js

EXPOSE 8080
ENV HOSTNAME=0.0.0.0

WORKDIR /app
CMD ["node", "apps/admin/server.js"]
