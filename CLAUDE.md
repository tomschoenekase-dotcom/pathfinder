# CLAUDE.md — PathFinderOS Engineering Constitution

> This file is the standing policy document for all coding sessions on this project.  
> Read `/docs/architecture.md` and `/docs/implementation-plan.md` before writing any code.  
> When this file conflicts with a comment in application code, this file wins.  
> When this file conflicts with the architecture doc, the architecture doc wins.

---

## Before Editing Any Code

- [ ] Have you read the task packet or description completely?
- [ ] Have you identified which package(s) and router(s) are affected?
- [ ] Have you confirmed the relevant migration exists before writing a query?
- [ ] Have you checked that no existing utility or helper already does what you need?
- [ ] Have you confirmed you are not introducing a new pattern where an existing one applies?
- [ ] If touching auth, tenant isolation, or the Prisma middleware — have you re-read those sections below?

---

## 1. Project Purpose

PathFinderOS is a multi-tenant SaaS platform for venues, attractions, and local businesses. It provides:
- A **public web app** for end customers to browse and book
- A **client dashboard** for tenant staff to manage their business
- An **internal admin console** for the platform owner to operate and support the platform

The platform must support many tenants simultaneously. No tenant may ever see another tenant's data.

---

## 2. Product Surfaces

| App | Location | Users | Auth Required |
|-----|----------|-------|--------------|
| Public web app | `apps/web` | End customers (guests) | No (rate-limited) |
| Client dashboard | `apps/dashboard` | Tenant staff | Yes — Clerk + org membership |
| Admin console | `apps/admin` | Platform owner only | Yes — `PLATFORM_ADMIN` claim |
| Worker process | `apps/workers` | No users — background jobs | N/A |

Each surface is a separate Next.js deployment. They share `packages/api`, `packages/db`, `packages/auth`, and `packages/ui`. They do not import from each other.

---

## 3. Architecture Summary

- **Framework:** Next.js 14+ App Router across all three surfaces
- **API layer:** tRPC v11 — all business logic lives in `packages/api/src/routers/`
- **Database:** PostgreSQL via Prisma — all access through `packages/db`
- **Auth:** Clerk — organizations map 1:1 to tenants
- **Jobs:** BullMQ in `apps/workers` — all async work is queued, never inline
- **Storage:** S3/R2 — presigned URLs only, never proxy through app server
- **Analytics:** `AnalyticsEvent` table for business events; PostHog for product analytics
- **Integrations:** Provider adapter pattern in `packages/integrations`

Full stack decisions and tradeoffs are in `/docs/architecture.md` Section 3.

---

## 4. Monorepo Boundaries

These rules are hard constraints. Violating them requires architect approval and a documented reason in the PR.

- `apps/*` may import from `packages/*`. Never the reverse.
- `apps/web`, `apps/dashboard`, and `apps/admin` must never import from each other.
- `packages/db` is the **only** package that imports `@prisma/client`. All other code imports `{ db }` from `@pathfinder/db`.
- `packages/auth` is the **only** package that imports `@clerk/nextjs` or `@clerk/clerk-sdk-node`. All auth resolution goes through this package.
- `packages/api` is the **only** package that defines tRPC routers. Apps mount the router; they do not define procedures.
- `packages/integrations` must not import from `packages/api`. Adapters are pure logic.
- `apps/workers` is the **only** runtime that imports `bullmq` directly. Other packages use `packages/jobs` abstractions.
- No circular dependencies between packages. Treat them as build failures.

Package dependency map (allowed directions only):
```
apps/* → packages/api → packages/db
                      → packages/auth
                      → packages/analytics
apps/* → packages/ui
apps/* → packages/auth
apps/workers → packages/integrations → packages/db (types only)
             → packages/jobs
             → packages/analytics
packages/* → packages/config
```

---

## 5. Multi-Tenant Rules

**The tenant isolation Prisma middleware is the most critical security control in the codebase. Do not modify it without a full review.**

- Every table that holds tenant data has a `tenant_id` column. See the full list in `/docs/implementation-plan.md` Section 5.
- Every query against a tenanted table must include `where: { tenant_id: ctx.activeTenantId }`.
- The Prisma middleware in `packages/db/src/middleware/tenant-isolation.ts` **throws** if a query against a tenanted table omits `tenant_id`. Do not catch or suppress this error.
- `activeTenantId` comes from the tRPC context, which resolves it from the Clerk JWT org claim. It is never read from a request body, URL param, or query string.
- Redis keys for tenant data are namespaced: `tenant:{id}:{resource}`. Never use an unnamespaced key for tenant-scoped data.
- Admin bypass (`bypassTenantIsolation`) exists for platform admin queries only. Using it outside of `admin.*` router procedures is a violation.
- A user may belong to multiple tenants. The **active** tenant for a request is always the one in the JWT org claim — never inferred from context.

---

## 6. Auth and Permission Rules

**Permission checks are server-side only. Frontend role checks are cosmetic and are not security controls.**

### Session Resolution Order

Every tRPC procedure that accesses data follows this exact order:

1. `requireAuth` — valid Clerk session must exist
2. `requireTenant` — `activeTenantId` resolved from JWT org claim
3. `requireRole(ctx, minRole)` — caller has sufficient role for the action
4. Resource ownership check — `entity.tenantId === ctx.activeTenantId`

Admin procedures replace steps 2–4 with `requirePlatformAdmin(ctx)`.

### Role Hierarchy

`STAFF < MANAGER < OWNER`

- `STAFF` — read-only + limited operational actions (check-ins, cancellations)
- `MANAGER` — operational CRUD, cannot manage billing or delete tenant
- `OWNER` — full tenant access including team and settings
- `PLATFORM_ADMIN` — separate from tenant roles; set in Clerk public metadata

### Rules

- Never trust a role claim sent from the client. Always resolve from the session.
- `isPlatformAdmin` is read from Clerk user public metadata field `platform_role: 'PLATFORM_ADMIN'`. Check with `=== 'PLATFORM_ADMIN'`, not truthy.
- `requireTenantRole` in `packages/auth/src/permissions.ts` uses numeric comparison — `OWNER > MANAGER > STAFF`. Do not do string equality role checks.
- `publicProcedure` is for unauthenticated access only (public listing reads, guest booking creation). Adding business logic to a `publicProcedure` requires explicit justification.

---

## 7. Data Access Rules

- Import `{ db }` from `@pathfinder/db`. Never instantiate `PrismaClient` directly.
- Do not use `db.$queryRaw` without a code comment explaining why. Any raw SQL must include an explicit `tenant_id` bind parameter.
- Do not use `db.$executeRaw` for data mutations — use Prisma's typed API.
- Do not call `db.*` from React components (including Server Components that render UI). Data fetching belongs in tRPC procedures called from the component.
- Use Prisma's `select` to whitelist returned fields. Never return a full model row that includes sensitive fields (`credentials`, `encrypted_*`).
- `IntegrationConnection.credentials` must never appear in any tRPC response. Always exclude it explicitly with `select` or `omit`.
- `db` client has the tenant isolation middleware and audit log middleware applied. Do not create a second `PrismaClient` instance to bypass them.

---

## 8. API / Server Action Rules

- All business logic lives in `packages/api/src/routers/`. Do not put business logic in Next.js route handlers, Server Actions, or React components.
- Plain Next.js API routes (`app/api/*/route.ts`) are used only for: Clerk webhooks, integration inbound webhooks, and presigned upload endpoints. Nothing else.
- All tRPC procedure inputs are validated with Zod in the `.input()` call. No exceptions.
- Zod schemas for inputs are defined in the same file as the router, unless shared across routers (then extracted to `packages/api/src/schemas/`).
- tRPC procedures throw `TRPCError` with appropriate codes. Never throw a raw `Error`. Never return `{ success: false, error: '...' }` — use the tRPC error system.
- Mutations that trigger async work (integration sync, email) enqueue a job and return `{ jobId }`. They do not await job completion.
- Do not add a new `publicProcedure` without verifying it exposes no tenant-private data.

### Base Procedure Reference

| Procedure | Use for |
|-----------|---------|
| `publicProcedure` | Unauthenticated reads and guest writes |
| `protectedProcedure` | Authenticated actions not yet tenant-scoped |
| `tenantProcedure` | All tenant-scoped operations (most procedures) |
| `adminProcedure` | Platform admin operations only |

---

## 9. Integration Framework Rules

- The `IntegrationAdapter` interface in `packages/integrations/src/types.ts` is **frozen**. Do not modify it without architectural review. New provider capabilities are added via optional extension, not interface mutation.
- Every integration provider is registered in `packages/integrations/src/registry.ts`. Adding a provider = one new entry in the registry map + one new adapter file. No other changes.
- Integration adapters are called from workers only. Never call an adapter directly from a tRPC procedure or API route.
- Integration credentials are encrypted before storage using `packages/integrations/src/crypto.ts`. The raw credential value never touches the database.
- Webhook endpoints verify the provider signature before reading the payload. An unverified webhook returns `401` and is not stored.
- Webhook handlers return `200` immediately after storing the raw event. Processing happens asynchronously via the `webhook-process` queue.
- Failed jobs follow the retry schedule: 30s → 1m → 5m → 30m → 2h. After 5 failures, the job is dead-lettered and `IntegrationConnection.status` is set to `'error'`.
- Every sync run writes an `IntegrationSyncLog` row. Every job writes a `JobRecord` row. These are not optional.

---

## 10. Analytics Event Rules

- `emitEvent()` from `packages/analytics` is called **server-side only** — from tRPC procedures and worker jobs. Never from client components.
- Before calling `emitEvent('noun.verb', ...)`, the event type must be defined in `packages/analytics/src/events.ts`. TypeScript enforces this — a type error means the event is not registered.
- Event naming convention: `noun.verb` in past tense — `booking.created`, `listing.published`, `integration.synced`.
- `emitEvent()` is wrapped in try/catch internally. A failed analytics write must never surface as a 500 to the user or fail a job. Log the error and continue.
- `emitEvent()` is called after the mutation succeeds, not before.
- Do not emit events on reads. Only emit on state changes.
- Business analytics (`AnalyticsEvent` table) and product analytics (PostHog) are separate. Do not send business transaction data to PostHog.
- The `AnalyticsEvent` table is append-only. No updates or deletes, ever.
- Dashboard analytics queries read from `analytics_events` or `DailyRollup` — not from OLTP tables (`bookings`, `listings`) for aggregates.

---

## 11. Admin Console Rules

- `apps/admin` is deployed separately from all other apps. It must never share a domain with the public app or dashboard.
- `apps/admin/middleware.ts` enforces `PLATFORM_ADMIN` on every route except `/sign-in`. This is not optional and must not be weakened.
- The `PLATFORM_ADMIN` check occurs in two independent places: the Next.js middleware (edge) and the `adminProcedure` tRPC middleware. Both must pass.
- Admin procedures that modify any data must call `writeAuditLog()` before returning. This includes: feature flag changes, tenant status changes, job requeue actions, impersonation session creation.
- Admin read access to tenant data uses the `bypassTenantIsolation` flag on the DB client. This flag is permitted only in `packages/api/src/routers/admin/` files.
- Impersonation sessions are scoped to a single `tenant_id` and expire after 1 hour. They cannot escalate to `PLATFORM_ADMIN`. Every action within an impersonation session is logged with `impersonated_by: adminUserId`.
- Do not build admin features using third-party admin panel tools. All admin UI is in `apps/admin`.

---

## 12. Background Job Rules

- All async work is queued via `packages/jobs/src/enqueue.ts`. Never enqueue a job by importing BullMQ directly from an app or other package.
- Queue names are constants in `packages/jobs/src/queues.ts`. Do not use string literals for queue names anywhere else.
- Job payload types are defined in `packages/jobs/src/types.ts`. `enqueue()` is typed — a compile error means the payload doesn't match.
- Every job must write a `JobRecord` on completion (success or failure). This is how admin console has visibility.
- Workers catch all errors, log them structurally, and update the `JobRecord` status. Workers must not crash on a single job failure.
- Workers handle `SIGTERM` gracefully — drain in-flight jobs before exit.
- The `apps/workers` process runs as a separate deployment (Railway or Docker). It is not a Vercel serverless function.
- Do not add cron schedules as Vercel cron jobs. All scheduled work is configured in `apps/workers/src/index.ts` using BullMQ's repeatable jobs.

---

## 13. Logging and Audit Rules

### Logging

- All logs are structured JSON using the shared logger from `packages/config/src/logger.ts`.
- Required fields on every log line: `timestamp`, `level`, `service`, `action`.
- Required fields when applicable: `tenantId`, `userId`, `requestId`.
- Do not log PII. Log IDs only — never email addresses, names, or phone numbers.
- Do not log credential fields or encrypted values. If logging a credentials object, log only the keys present, not values.
- Every worker job logs at `info` on start and on completion.
- Errors at `warn` or above must include `tenantId` (if applicable), `action`, and `error.message`.

### Audit Logging

- `AuditLog` is written for: every CREATE, UPDATE, DELETE on business entities; every admin action; every impersonation event.
- `writeAuditLog()` helper in `packages/db/src/helpers/audit.ts` is used for all writes — do not write to `AuditLog` via `db.auditLog.create()` directly.
- `AuditLog` is append-only. No `updatedAt`, no soft-delete, no hard-delete. Ever.
- `AuditLog.tenant_id` is nullable — platform-level actions (no tenant context) set it to null.
- The Prisma audit middleware handles automatic logging for most mutations. When writing an audit log manually, include `before_state` and `after_state` snapshots where available.

---

## 14. Testing Expectations

- Every tRPC procedure has at least one test for the forbidden path — wrong tenant or insufficient role — returning `FORBIDDEN`.
- The tenant isolation middleware (`packages/db/src/middleware/tenant-isolation.ts`) has 100% branch coverage. This is a CI gate.
- Unit tests: `*.test.ts` next to the file they test.
- Integration tests: `*.integration.test.ts` — use a real test database, not mocks.
- E2E tests: `apps/{app}/e2e/*.spec.ts` using Playwright — cover auth, booking creation, and dashboard access.
- Use `vi.mock()` sparingly. Prefer a test database over mocking DB calls for integration tests.
- New security-critical code (auth guards, permission checks, isolation middleware) must have tests before merging.
- CI runs `typecheck`, `lint`, and `test` on every PR. A PR cannot merge with any of these failing.

---

## 15. UI / Component Rules

- Before creating a component in `apps/{app}/components/`, check if it belongs in `packages/ui`.
- A component belongs in `packages/ui` if it is used (or will be used) in more than one app.
- `packages/ui` components use shadcn/ui as the base. Styles are applied via `className` — no hardcoded color or spacing values.
- Icons: `lucide-react` only. Do not add another icon library.
- Do not put data-fetching logic in `packages/ui` components. They receive data as props.
- Do not put permission checks in components. Components receive pre-filtered data and may hide/show UI elements for UX purposes only.
- Use `next/link` for internal navigation. Never `<a href>` for internal routes.
- Forms use `react-hook-form` with `zodResolver`. The Zod schema used by the form is imported from the tRPC router package — not duplicated.

---

## 16. Package Management Rules

- Package manager is `pnpm`. Do not use `npm` or `yarn` commands.
- `pnpm-lock.yaml` is always committed. CI uses `--frozen-lockfile`.
- Before adding a new dependency, check if `packages/config` or an existing package already provides it.
- Runtime dependencies in `packages/config` are forbidden — it is a pure config package.
- `devDependencies` for shared tooling go in the root `package.json`. Package-specific tools go in the package's own `package.json`.
- All internal packages have `"private": true`.
- When adding a new `npm` package, include justification in the PR description. One-liner utilities from `lodash` or similar are not acceptable when the standard library or existing utilities cover it.

---

## 17. Schema Migration Rules

- Migrations live in `packages/db/prisma/migrations/`. Run from `packages/db` only: `pnpm db:migrate`.
- Migrations are numbered and named: `001_identity_foundation`, `002_platform_controls`, etc.
- The migration order defined in `/docs/implementation-plan.md` Section 5 is the canonical sequence. Do not add tables out of order if they have dependencies on earlier migrations.
- New tenanted tables must be added to the tenanted-tables list in `packages/db/src/middleware/tenant-isolation.ts` at the same time as the migration.
- `AuditLog` must not get `@updatedAt`. Do not add it.
- `User.id` and `Tenant.id` are `String` — Clerk provides the IDs. Do not change them to auto-increment or `uuid()`.
- Do not use `onDelete: Cascade` without explicit justification. Default is `Restrict`.
- Migrations are forward-only in production. Write a new migration to undo a change — do not edit an existing migration file after it has been applied.
- Before proposing any schema change, complete the checklist below.

### Before Proposing Schema Changes

- [ ] Is the table tenanted? If yes, does it have `tenant_id String` and is it added to the isolation middleware?
- [ ] Are the required indexes defined? (See `/docs/implementation-plan.md` Section 5 indexes table)
- [ ] Does the table need `createdAt`? Does it need `updatedAt`? (`AuditLog` must not have `updatedAt`)
- [ ] Are foreign key `onDelete` behaviors explicitly set?
- [ ] If this adds a column to an existing table with `NOT NULL`, is a default value or migration data fill provided?
- [ ] Is this migration dependent on a previous migration that hasn't been applied yet?

---

## 18. Forbidden Anti-Patterns

These patterns are never acceptable. Encountering one in existing code is a bug, not a precedent.

| Anti-pattern | Why forbidden |
|-------------|--------------|
| `import { PrismaClient } from '@prisma/client'` in an app | Bypasses tenant isolation middleware |
| `import { clerkClient } from '@clerk/nextjs'` outside `packages/auth` | Creates untracked auth dependency |
| `activeTenantId` from URL params, query string, or request body | Tenant must come from JWT only |
| Permission checks in React components (for security) | Server-side only — components are cosmetic |
| `db.$queryRaw` without explicit `tenant_id` bind | Bypasses row-level isolation |
| `emitEvent()` from a client component | Analytics writes are server-side only |
| Synchronous external API call in a web request | Use `enqueue()` — external services are unreliable |
| New tRPC router defined in an `apps/*` directory | All routers live in `packages/api` |
| Returning `IntegrationConnection.credentials` in a tRPC response | Credentials must never reach the client |
| Direct `db.auditLog.create()` call | Use `writeAuditLog()` helper |
| `AuditLog` update or delete | Append-only — no exceptions |
| Shared state between `apps/*` via direct import | Apps are independent deployments |
| Hardcoded feature flag key strings | Keys must come from `packages/config/src/feature-flags.ts` |
| `throw new Error(...)` from a tRPC procedure | Use `throw new TRPCError(...)` |
| Business aggregate queries against OLTP tables in dashboard components | Use `analytics_events` or `DailyRollup` |

---

## 19. Change Review Checklist

Use this before submitting or approving any PR.

### Every PR

- [ ] `turbo run typecheck` — zero errors
- [ ] `turbo run lint` — zero errors
- [ ] `turbo run test` — all tests pass
- [ ] No `console.log` with PII (emails, names, phone numbers)
- [ ] No new patterns introduced where existing patterns apply

### PRs Touching Auth or Permissions

- [ ] No permission check added to a React component for security purposes
- [ ] `requireRole` or `requirePlatformAdmin` is the first logic in every affected procedure
- [ ] `activeTenantId` is not read from request input
- [ ] `isPlatformAdmin` checked with `=== 'PLATFORM_ADMIN'`, not truthy

### PRs Touching the DB Layer

- [ ] No direct `PrismaClient` instantiation outside `packages/db`
- [ ] New tenanted tables added to isolation middleware list
- [ ] `IntegrationConnection.credentials` excluded from all responses
- [ ] Tenant isolation middleware tests still pass at 100% branch coverage

### PRs Adding a New tRPC Procedure

- [ ] Procedure lives in `packages/api/src/routers/`
- [ ] Input validated with Zod in `.input()`
- [ ] Correct base procedure used (`publicProcedure`, `tenantProcedure`, `adminProcedure`)
- [ ] `FORBIDDEN` path has a test
- [ ] Admin procedures call `writeAuditLog()`

### PRs Adding an Integration Provider

- [ ] Provider implements `IntegrationAdapter` interface fully — no partial implementation
- [ ] Provider registered in `packages/integrations/src/registry.ts`
- [ ] Credentials encrypted via `packages/integrations/src/crypto.ts` — not stored raw
- [ ] Webhook signature verification implemented and tested
- [ ] Adapter is not called from a tRPC procedure directly

---

## 20. How to Behave When Uncertain

- **Uncertain about which package owns a piece of logic?** — Read Section 4 of `/docs/implementation-plan.md` (Core Module Contracts). If still unclear, put it in the most specific package that can own it without creating a circular dependency.
- **Uncertain about whether a table is tenanted?** — Default to yes. Add `tenant_id` and register it in the isolation middleware. Removing a `tenant_id` from a table that doesn't need it is trivial; adding one retroactively requires a migration and data fix.
- **Uncertain about whether a new route handler or a tRPC procedure is correct?** — Use a tRPC procedure. Plain route handlers are only for webhooks, file uploads, and Clerk callbacks.
- **Uncertain about whether to add a dependency?** — Don't add it yet. Write the logic inline. If it becomes a pattern across more than two files, then extract or introduce the dependency.
- **Uncertain about whether an admin action needs an audit log?** — If it modifies any data, it needs one. When in doubt, log it.
- **Uncertain about whether a feature flag is needed?** — If the capability is plan-gated or can be toggled per-tenant, use a feature flag. Define the key in `packages/config/src/feature-flags.ts` first.
- **Uncertain about the correct role for a procedure?** — Default to `MANAGER`. If the action could cause irreversible harm (delete, disconnect), use `OWNER`. If it is read-only or operationally routine, use `STAFF`.
- **Do not invent a new architectural pattern.** If the task requires something not covered by existing patterns, stop and flag it in the PR description for human review before implementing.

---

## Golden Path: How to Add a New Feature

This is the correct sequence for adding any new tenant-facing capability:

1. **Identify the data.** Does it need a new table? If yes, write a Prisma migration following the rules in Section 17. Is the table tenanted? Register it in the isolation middleware.
2. **Define the event.** If the feature creates a meaningful state change, add the event type to `packages/analytics/src/events.ts`.
3. **Write the tRPC procedure.** Add it to the correct router in `packages/api/src/routers/`. Use `tenantProcedure`. Apply the correct role. Validate input with Zod. Call `emitEvent()` on success.
4. **Write the test.** At minimum: one success path and one `FORBIDDEN` path (wrong tenant or insufficient role).
5. **Build the UI.** Add the page or component in the correct app. Call the tRPC procedure. Use `packages/ui` components. Do not add permission logic to the component.
6. **Wire async work.** If the feature needs background processing, define the job payload type in `packages/jobs/src/types.ts`, call `enqueue()` from the procedure, and implement the worker in `apps/workers`.

---

## Definition of Architectural Drift

Architectural drift occurs when code deviates from the patterns established in this file and the architecture documents. Examples of drift:

- A tRPC router defined inside `apps/dashboard` instead of `packages/api`
- A direct `@prisma/client` import in an app file
- A permission check in a React component treated as a security control
- A new `console.log` replacing structured logging
- A direct synchronous call to an external API inside a web request
- An analytics query running against `bookings` or `listings` OLTP tables for aggregate dashboard metrics
- A feature flag key hardcoded as a string literal
- A new BullMQ queue created outside of `packages/jobs`
- An admin action that does not write to `AuditLog`
- A second Prisma client instance created to bypass middleware

If you encounter drift in existing code, note it in the PR but do not fix it as part of an unrelated task. File it as a separate issue.

---

*End of CLAUDE.md. This file is the engineering constitution for PathFinderOS. It does not expire. Update it only when architecture.md is updated.*
