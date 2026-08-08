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
- Platform-admin pages and routes live inside `apps/dashboard`; there is no separate `apps/admin` workspace.
- `apps/workers` runs BullMQ background jobs.
- `packages/api` owns tRPC business logic.
- `packages/db` owns Prisma, schema, migrations, tenant isolation, audit helpers, semantic search, and job records.
- `packages/auth` owns Clerk session and permission helpers.
- `packages/analytics` owns the server-side analytics emitter plus the complete and public-client event catalogs.
- `packages/jobs` owns queue names, job payload types, Redis connection, and enqueue helpers.
- `packages/config` owns shared logger, env, feature flag keys, eslint config, and tsconfig bases.
- `packages/ui` is the shared presentational component package.

Not built: listings, bookings, venue events, guest-user accounts, availability slots, third-party product analytics, general outbound integrations, and booking expiry jobs. No product-analytics vendor is currently selected or configured; older PostHog design references are historical, and the internal tenant analytics pipeline remains authoritative. Do not infer absence from older planning documents: multipart media storage, audited cookie-based admin impersonation, AI provider adapters, Clerk webhook processing, and welcome-email dispatch are implemented, although live-provider readiness still depends on environment configuration and stage evidence.

## Extensible Platform Constraints

PathFinder is one shared platform. Preserve three independent concepts instead of expanding
`guideMode` or another single field into a giant product mode:

- venue archetype describes the kind of place and should primarily select configuration/defaults;
- audience describes who may access an experience or content;
- capabilities describe enabled modules and behavior.

Do not fork chat, retrieval, analytics, billing, tenant isolation, or AI-provider infrastructure by
vertical. Do not add client-name/slug conditionals. `guideMode` is only the current navigation/location
profile, tenant roles are operator authority, and tenant feature flags are release controls; none is an
audience or archetype. Do not introduce archetype, audience, or `AssistantExperience` migrations until
an approved current use case defines their semantics. When restricted audiences are implemented,
authorization must filter content before retrieval/model context; prompt instructions are not a
security boundary.

## Monorepo Boundaries

- `apps/*` may import from `packages/*`; packages must not import from apps.
- `apps/web` and `apps/dashboard` must not import from each other.
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

Every Prisma model must appear in exactly one registry in `packages/db/src/tenanted-tables.ts`:
`TENANTED_TABLES`, `PLATFORM_TABLES`, or the explicit mixed `SHARED_SCOPE_TABLES`. Models with a
required `tenantId` belong in `TENANTED_TABLES`. `pnpm verify:tenant-registry` enforces this in CI.

Rules:

- Every query against a tenanted table must include `tenant_id`.
- `activeTenantId` comes from Clerk org context via `packages/auth`; never read it from client input.
- Public cross-tenant raw SQL is allowed only when resolving public resources such as venue slug or anonymous session token, and the code must explain why.
- Raw SQL for pgvector must bind `tenant_id` explicitly. CI pins every production raw SQL template and its interpolation expressions; unsafe methods, detached calls, computed access, and Prisma raw-fragment helpers are prohibited.
- `withTenantIsolationBypass` is allowed only for platform-admin procedures and worker processors that explicitly filter by tenant. Every invocation emits a structured `tenant_isolation.bypass` log with its normalized caller; never suppress or bypass that audit event. CI pins the approved production files and exact call counts; update that boundary only with a security review.
- Every `tenantProcedure` must have a generated cross-tenant case. The case must reach its first database or external boundary using the minimum real role and prove every observed call carries the authenticated tenant; request input must never supply tenant authority.
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
- Plain Next.js route handlers are limited integration boundaries. Current reviewed exceptions include tRPC mounting, Clerk webhooks, health checks, and the audited admin-impersonation transition; new handlers require an explicit boundary review.
- Validate every tRPC input with Zod.
- Shared API schemas live in `packages/api/src/schemas/`.
- Throw `TRPCError` from procedures; do not return ad hoc error objects.
- Mutations that need external work should enqueue jobs and return promptly.
- Do not add a `publicProcedure` until verifying it exposes no tenant-private data.

## Analytics

- `emitEvent()` from `packages/analytics` is server-side only. Browser code writes only through the validated public analytics mutation.
- Event types must be in the authoritative catalogs in `packages/analytics/src/events.ts`.
- Current public-client allow-list:
  - `session.started`
  - `session.ended`
  - `message.sent`
  - `place_card.viewed`
  - `place_card.clicked`
  - `directions.opened`
  - `operational_update.viewed`
- Server-only events include:
  - `message.received`
  - `message.fallback`
  - `message.low_confidence`
  - `venue.updated`
  - `engagement_question.asked`
- Never add a server-derived reliability or business event to the public-client allow-list merely because it exists in the complete catalog.
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
- External services should fail open only where product behavior can degrade safely. The public, spend-bearing chat rate limiter requires Redis and fails closed in production; staging and preview retain a bounded in-process fallback.

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
