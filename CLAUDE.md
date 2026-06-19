# CLAUDE.md - PathFinder Engineering Constitution

> Standing policy for coding agents working in this repository.
> `docs/codebase-overview.md` and the real code are the current source of truth.
> `docs/architecture.md` is historical design intent and describes several systems that are not built.

## Before Editing

- Read the task packet completely.
- Identify the affected app, package, router, schema, and tests.
- Check whether an existing helper already owns the behavior.
- Preserve package boundaries and tenant isolation.
- Do not touch parallel-work areas called out in the active task packet.

## Product Reality

PathFinder is an AI-powered venue-guide chatbot platform.

- `apps/web` is the public guest chat app.
- `apps/dashboard` is the tenant operator console.
- `apps/admin` is built but deployment is in flux; admin work may be happening in parallel.
- `apps/workers` runs BullMQ background jobs.
- `packages/api` owns tRPC business logic.
- `packages/db` owns Prisma, schema, migrations, tenant isolation, audit helpers, semantic search, and job records.
- `packages/auth` owns Clerk session and permission helpers.
- `packages/analytics` owns the server-side analytics emitter and event allow-list.
- `packages/jobs` owns queue names, job payload types, Redis connection, and enqueue helpers.
- `packages/config` owns shared logger, env, feature flag keys, eslint config, and tsconfig bases.
- `packages/ui` is the shared presentational component package.

Not built: listings, bookings, events, guest-user accounts, availability slots, file upload storage, admin impersonation sessions, PostHog wiring, outbound integrations, provider adapters, webhook processing, email dispatch, and booking expiry jobs.

## Monorepo Boundaries

- `apps/*` may import from `packages/*`; packages must not import from apps.
- `apps/web`, `apps/dashboard`, and `apps/admin` must not import from each other.
- `packages/db` is the only package that imports `@prisma/client`.
- `packages/auth` is the only package that imports Clerk server SDKs.
- `packages/api` is the only package that defines tRPC routers.
- `apps/workers` is the only runtime that imports `bullmq` for workers.
- Other code enqueues through `packages/jobs`.
- Do not create package cycles.

Allowed dependency direction:

```text
apps/*       -> packages/api -> packages/db
                            -> packages/auth
                            -> packages/analytics
apps/*       -> packages/auth
apps/*       -> packages/ui
apps/workers -> packages/jobs
apps/workers -> packages/db
apps/workers -> packages/analytics
apps/workers -> packages/config
packages/*   -> packages/config
```

Workers must not import `@pathfinder/api`.

## Tenant Isolation

Tenant isolation is the core security control. The middleware in `packages/db/src/middleware/tenant-isolation.ts` must throw when tenant-scoped queries omit `tenant_id`.

Tenanted models must match `packages/db/src/tenanted-tables.ts`:

- `TenantMembership`
- `TenantFeatureFlag`
- `Venue`
- `Place`
- `VisitorSession`
- `Message`
- `DataAdapter`
- `OperationalUpdate`
- `AnalyticsEvent`
- `DailyRollup`
- `WeeklyDigest`

Rules:

- Every query against a tenanted table must include `tenant_id`.
- `activeTenantId` comes from Clerk org context via `packages/auth`; never read it from client input.
- Public cross-tenant raw SQL is allowed only when resolving public resources such as venue slug or anonymous session token, and the code must explain why.
- Raw SQL for pgvector must bind `tenant_id` explicitly.
- `withTenantIsolationBypass` is allowed only for platform-admin procedures and worker processors that explicitly filter by tenant.
- Redis keys containing tenant data must be tenant namespaced.

## Auth and Roles

Permission checks are server-side only. UI role checks are cosmetic.

- `publicProcedure`: unauthenticated guest-safe reads/writes.
- `protectedProcedure`: authenticated actions that are not tenant scoped.
- `tenantProcedure`: authenticated tenant-scoped operator actions.
- `adminProcedure`: platform-owner actions only.

Role order is `STAFF < MANAGER < OWNER`. Platform admin is a separate Clerk public metadata value, `platform_role === 'PLATFORM_ADMIN'`.

Rules:

- Never trust role or tenant IDs from the client.
- Use `requireTenantRole` and `requirePlatformAdmin` from `packages/auth`.
- Use `requireRole('MANAGER')` or stricter for mutating operator procedures.
- Admin procedures must use `adminProcedure`; do not reimplement the platform-admin check.

## Data Access

- Import `{ db }` from `@pathfinder/db`; never instantiate `PrismaClient` outside `packages/db`.
- Use Prisma typed APIs for mutations unless pgvector/raw SQL makes that impossible.
- Every `db.$queryRaw` must include either an explicit `tenant_id` bind or a comment explaining a deliberate public cross-tenant lookup.
- Prefer `updateMany`/`deleteMany` with `tenant_id` filters when a unique-key Prisma update cannot include tenant scope.
- Use `select` to return only fields needed by the caller.
- Do not call `db` directly from React components. Business data fetching belongs in tRPC procedures.
- `AuditLog` and `AnalyticsEvent` are append-only.

## API Rules

- Business logic lives in `packages/api/src/routers/`.
- Apps mount/call `appRouter`; apps do not define tRPC procedures.
- Plain Next.js route handlers are for tRPC mounting and Clerk webhooks only unless a task explicitly adds another integration point.
- Validate every tRPC input with Zod.
- Shared API schemas live in `packages/api/src/schemas/`.
- Throw `TRPCError` from procedures; do not return ad hoc error objects.
- Mutations that need external work should enqueue jobs and return promptly.
- Do not add a `publicProcedure` until verifying it exposes no tenant-private data.

## Analytics

- `emitEvent()` from `packages/analytics` is server-side only.
- Event types must be in `packages/analytics/src/events.ts`.
- Current allow-list:
  - `session.started`
  - `session.ended`
  - `message.sent`
  - `message.received`
  - `place_card.viewed`
  - `place_card.clicked`
  - `directions.opened`
  - `operational_update.viewed`
  - `venue.updated`
- `emitEvent()` is best-effort and must not break user-facing flows.
- Emit after successful state changes.
- Dashboard analytics reads should use `AnalyticsEvent`, `DailyRollup`, or `WeeklyDigest`, not ad hoc component queries.

## Background Jobs

- Queue names and job names live in `packages/jobs/src/queues.ts`.
- Payload types live in `packages/jobs/src/types.ts`.
- Enqueue helpers live in `packages/jobs/src/enqueue.ts`.
- Worker processors live in `apps/workers/src/processors/`.
- Every processor writes and updates a `JobRecord` with `writeJobRecord` and `updateJobRecord`.
- Workers log structurally through `packages/config/src/logger.ts`.
- Workers handle shutdown gracefully.
- External services such as OpenAI, Anthropic, Redis, and job queues should fail open where product behavior can degrade safely.

## Logging and Audit

- Use `packages/config/src/logger.ts` for structured logs.
- Log IDs and operational context, not PII.
- Do not log secrets, credentials, prompt payloads containing private user data, or encrypted values.
- Use `writeAuditLog()` from `packages/db/src/helpers/audit.ts` for manual audit writes.
- State-changing tenant/admin actions should have audit coverage unless the existing audit helper already covers them.

## UI Components

- Shared presentational components used by more than one app belong in `packages/ui`.
- `packages/ui` must not fetch data or enforce permissions.
- App-specific workflow components stay in their app.
- Use existing styling conventions in each app.

## Testing

- Add or update focused tests for changed behavior.
- Security-sensitive changes need forbidden-path tests.
- Worker changes need processor/enqueue coverage when practical.
- Tenant isolation middleware must stay covered.
- Run from the repo root before finalizing:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

## Migrations

- Prisma schema and migrations live under `packages/db/prisma/`.
- Migrations are forward-only.
- New tenanted tables must include `tenant_id` and be added to `packages/db/src/tenanted-tables.ts`.
- Do not edit applied migrations.
- `User.id` and `Tenant.id` are Clerk string IDs.
- Avoid cascade deletes unless the task explicitly justifies them.
- Use the exact optional spread pattern for Prisma data under `exactOptionalPropertyTypes`:

```ts
...(value !== undefined ? { field: value } : {})
```

## Forbidden Patterns

| Pattern                                                     | Use instead                                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| tRPC routers in `apps/*`                                    | `packages/api/src/routers/`                                                       |
| Direct `PrismaClient` outside `packages/db`                 | `{ db }` from `@pathfinder/db`                                                    |
| Worker importing `@pathfinder/api`                          | Move shared logic to `packages/db`, `packages/config`, or another neutral package |
| Client-emitted business analytics                           | Server-side `emitEvent()`                                                         |
| Synchronous external calls in web mutations                 | `packages/jobs` enqueue helper + worker                                           |
| Raw SQL without tenant binding or public-lookup explanation | Prisma typed query or explicit tenant-bound raw SQL                               |
| Permission checks in UI treated as security                 | tRPC middleware and auth helpers                                                  |
| `throw new Error()` in procedures                           | `TRPCError`                                                                       |
| Updating/deleting `AuditLog` or `AnalyticsEvent`            | Append-only writes                                                                |

## Golden Paths

### Add a Field to `Place`

1. Update `packages/db/prisma/schema.prisma`.
2. Add a forward-only migration under `packages/db/prisma/migrations/`.
3. Update `packages/api/src/schemas/place.ts`.
4. Update `packages/api/src/routers/place.ts`.
5. If the field should influence semantic search, update the shared place-text builder.
6. Update dashboard place forms and tests.
7. Run typecheck, lint, and tests.

### Add an Analytics Event

1. Add the event name to `packages/analytics/src/events.ts`.
2. Emit it server-side from the relevant tRPC procedure or worker after success.
3. Include tenant, venue, session, or subject IDs needed by dashboard queries.
4. Add or update tests.

### Add a Background Job

1. Add queue/job constants in `packages/jobs/src/queues.ts`.
2. Add the payload type in `packages/jobs/src/types.ts`.
3. Add an enqueue helper in `packages/jobs/src/enqueue.ts`.
4. Add a processor in `apps/workers/src/processors/`.
5. Register the worker in `apps/workers/src/index.ts`.
6. Write `JobRecord` status updates.
7. Add tests for enqueue and processor behavior.

## When Unsure

- Follow `docs/codebase-overview.md` over historical docs.
- Prefer existing package ownership and helper APIs.
- Keep changes scoped to the task.
- If a task seems to require touching a forbidden parallel-work path, do not edit it; note the conflict in the PR description.
