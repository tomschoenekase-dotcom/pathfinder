# Codex Backlog — PathFinderOS

> Work through these tasks in order. Each task is self-contained. Run
> `pnpm typecheck` and `pnpm --filter @pathfinder/api test` after every task
> to verify nothing is broken before moving to the next one.
>
> Read `CLAUDE.md` in full before starting. All rules there apply.

---

## Task 1 — Fix failing tenant isolation test

**File:** `packages/db/src/middleware/tenant-isolation.test.ts`

The test at line 66 asserts the tenanted tables list but is missing `WeeklyDigest`,
which was added to `packages/db/src/tenanted-tables.ts` in a recent migration phase.

**Fix:** Add `'WeeklyDigest'` to the expected array in the `toEqual` call at line 66,
after `'DailyRollup'`. The array should end:

```
'DailyRollup',
'WeeklyDigest',
```

**Verify:** `pnpm --filter @pathfinder/db test` passes with zero failures.

---

## Task 2 — Add a start script to the workers package

**File:** `apps/workers/package.json`

The workers package has no `start` script so it cannot run in production.
The entry point is `apps/workers/src/index.ts`, which must be compiled to JS first.

**Fix:**

1. Add a `start` script that runs the compiled output:
   ```json
   "start": "node dist/index.js"
   ```
2. Update the `build` script to compile to `dist/` instead of just typechecking:
   ```json
   "build": "tsc --project tsconfig.json"
   ```
3. Check `apps/workers/tsconfig.json`. Make sure it has `"outDir": "dist"` and
   `"noEmit"` is either absent or set to `false`. If `tsconfig.json` doesn't exist,
   create one that extends the root tsconfig and sets `outDir` to `dist`.

**Verify:** `pnpm --filter @pathfinder/workers build` produces a `dist/index.js` file.

---

## Task 3 — Add a Dockerfile for the workers service

**File:** `Dockerfile.workers` (new file, root of repo)

The dashboard has a `Dockerfile` but there is none for workers. Workers need their
own image to run as a separate Railway service.

**Create `Dockerfile.workers`** following the same Alpine + pnpm pattern as the
existing `Dockerfile`, but building and running the workers app instead of the
dashboard:

```dockerfile
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
RUN pnpm --filter @pathfinder/workers build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/apps/workers/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

# Copy Prisma engine binary for Alpine Linux
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/*.node ./node_modules/.pnpm/@prisma+client@6.19.3_prisma@6.19.3_magicast@0.3.5_typescript@5.9.3__typescript@5.9.3/node_modules/.prisma/client/

CMD ["node", "dist/index.js"]
```

**Note:** The Prisma client version in the COPY path (`6.19.3`) must match what is
actually installed. Check `node_modules/.pnpm/` to confirm the exact version string
before writing the path.

---

## Task 4 — Add railway.workers.json for the workers Railway service

**File:** `railway.workers.json` (new file, root of repo)

Railway needs a separate config to deploy the workers as a second service.

**Create `railway.workers.json`:**

```json
{
  "$schema": "https://schema.railway.app/railway.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile.workers"
  },
  "deploy": {
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

This file is checked into the repo. When you create the second Railway service,
point it at this config file in the Railway dashboard.

---

## Task 5 — Verify the Clerk webhook route is excluded from auth middleware

**File:** `apps/dashboard/middleware.ts`

The webhook at `/api/webhooks/clerk` was previously returning 307 redirects because
the Clerk auth middleware was intercepting it. It has already been added to
`PUBLIC_ROUTES` (line 5), but confirm the following:

1. The `matcher` in `export const config` (line 37) includes `/(api|trpc)(.*)`.
   This means the middleware runs on webhook requests — which is correct, as long as
   the `PUBLIC_ROUTES` check fires before `auth()` is called.
2. Confirm that the `PUBLIC_ROUTES` check at line 15 returns `NextResponse.next()`
   **before** the `auth()` call at line 19. It does — this is correct.
3. No change needed if the above is confirmed. Document in a comment why the
   webhook route must stay in `PUBLIC_ROUTES` so it isn't accidentally removed:

   ```ts
   // /api/webhooks/clerk must remain here — Clerk sends webhook POST requests
   // without a session cookie, so auth() would redirect them and break tenant sync.
   const PUBLIC_ROUTES = ['/api/webhooks/clerk']
   ```

**Verify:** `pnpm typecheck` passes. No logic changes needed if the route is already
present and ordered correctly — this task is a confirmation + comment only.

---

## Task 6 — Apply the pending database migrations to production

This is a manual step, not a code change. The following migrations exist as SQL
files but have not been applied to the production Supabase database:

- `packages/db/prisma/migrations/20260413120000_add_weekly_digest/migration.sql`
- `packages/db/prisma/migrations/20260413130000_add_job_records/migration.sql`

**Steps:**

1. Open the Supabase dashboard for the production project.
2. Go to the SQL Editor.
3. Run the contents of `20260413120000_add_weekly_digest/migration.sql`.
4. Run the contents of `20260413130000_add_job_records/migration.sql`.
5. Confirm the `weekly_digests` and `job_records` tables appear in the Table Editor.

**Note for Codex:** This cannot be done in code. Flag this task as requiring manual
execution by the developer. Output a clear reminder that these two SQL files need to
be run in Supabase before the workers or analytics features will function correctly
in production.

---

## Definition of done

All tasks complete when:

- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm --filter @pathfinder/db test` — all tests pass including tenant isolation
- [ ] `pnpm --filter @pathfinder/workers build` — produces `dist/index.js`
- [ ] `Dockerfile.workers` exists at repo root
- [ ] `railway.workers.json` exists at repo root
- [ ] Middleware comment added confirming webhook exclusion
- [ ] Developer has been reminded to run the two pending SQL migrations in Supabase
