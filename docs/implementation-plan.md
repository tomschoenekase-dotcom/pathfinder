# PathFinderOS — Implementation Plan

> Version: 1.0  
> Author: Principal Engineer  
> Date: 2026-04-11  
> Status: Canonical execution reference  
> Depends on: `/docs/architecture.md` (read it first)  
> Intended consumers: Codex, engineering leads, AI coding agents

---

## 1. Repo Strategy

### Decision: Turborepo Monorepo

All code lives in a single git repository managed by **Turborepo**. This is non-negotiable given the architecture — the three Next.js surfaces share tRPC router types, Prisma types, UI components, and utilities. A polyrepo would require publishing packages on every change and would cause type drift between surfaces immediately.

**Why Turborepo specifically:**
- Incremental builds with remote caching (free on Vercel)
- `turbo run build/test/lint` runs tasks in dependency order automatically
- Works with `pnpm workspaces` for package management
- No new patterns required — it wraps existing tooling

**Package manager: `pnpm`**  
Strict hoisting rules, faster installs, better workspace support than npm/yarn.

### Major Apps and Packages

| Workspace | Type | Purpose |
|-----------|------|---------|
| `apps/web` | Next.js app | Public-facing web app (SSR/SSG) |
| `apps/dashboard` | Next.js app | Client/company dashboard (authenticated) |
| `apps/admin` | Next.js app | Internal admin console (platform owner only) |
| `apps/workers` | Node.js process | BullMQ job workers (runs separately, not serverless) |
| `packages/db` | Library | Prisma schema, client, migrations, seed, tenant middleware |
| `packages/api` | Library | tRPC router definitions, all procedures |
| `packages/auth` | Library | Clerk helpers, session resolution, permission guards |
| `packages/ui` | Library | Shared React component library (shadcn/ui base) |
| `packages/integrations` | Library | IntegrationAdapter interface, provider registry, all adapters |
| `packages/jobs` | Library | BullMQ queue definitions, job type contracts |
| `packages/config` | Library | Shared TypeScript configs, ESLint config, env schema (Zod) |
| `packages/analytics` | Library | AnalyticsEvent emitter, event type definitions |

### Boundary Rules Between Packages

These rules are **hard constraints** that Codex must never violate:

1. **Apps may depend on packages. Packages must never depend on apps.**
2. **`packages/db` is the only package that imports Prisma.** Apps and other packages import DB utilities from `packages/db`, never from `@prisma/client` directly.
3. **`packages/api` is the only package that defines tRPC routers.** Apps mount the router but do not define procedures.
4. **`packages/auth` is the only package that imports Clerk's SDK.** All auth resolution goes through this package.
5. **`apps/admin` must never import from `apps/dashboard` or `apps/web`.** They are independent surfaces.
6. **`packages/integrations` must never import from `packages/api`.** Adapters are pure logic — no HTTP calls back into the platform.
7. **`apps/workers` is the only runtime that imports `bull`/`bullmq` directly.** Other packages use `packages/jobs` abstractions.
8. **No circular dependencies between packages.** Turborepo will catch these; treat them as build failures.

---

## 2. Concrete Folder Structure

```
pathfinder/
├── .github/
│   └── workflows/
│       ├── ci.yml                  # lint, typecheck, test on every PR
│       └── deploy.yml              # deploy preview/production on merge
│
├── apps/
│   ├── web/                        # Public-facing Next.js app
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx            # Platform root / redirect
│   │   │   └── [tenantSlug]/       # Per-tenant public pages
│   │   │       ├── page.tsx        # Tenant homepage
│   │   │       ├── listings/
│   │   │       │   ├── page.tsx
│   │   │       │   └── [listingId]/
│   │   │       │       └── page.tsx
│   │   │       └── book/
│   │   │           └── [listingId]/
│   │   │               └── page.tsx
│   │   ├── components/             # Web-app-only components
│   │   ├── lib/
│   │   │   └── trpc.ts             # tRPC client for web app
│   │   ├── middleware.ts            # Rate limiting, tenant slug resolution
│   │   ├── next.config.ts
│   │   └── package.json
│   │
│   ├── dashboard/                  # Client/company dashboard
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── (auth)/
│   │   │   │   ├── sign-in/
│   │   │   │   └── sign-up/
│   │   │   └── (app)/
│   │   │       ├── layout.tsx      # Auth gate + tenant resolver
│   │   │       ├── onboarding/
│   │   │       ├── listings/
│   │   │       ├── bookings/
│   │   │       ├── analytics/
│   │   │       ├── integrations/
│   │   │       ├── team/
│   │   │       └── settings/
│   │   ├── components/             # Dashboard-only components
│   │   ├── lib/
│   │   │   └── trpc.ts
│   │   ├── middleware.ts            # Clerk auth middleware
│   │   ├── next.config.ts
│   │   └── package.json
│   │
│   ├── admin/                      # Internal admin console
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── (auth)/
│   │   │   │   └── sign-in/
│   │   │   └── (app)/
│   │   │       ├── layout.tsx      # PLATFORM_ADMIN gate — hard wall
│   │   │       ├── tenants/
│   │   │       ├── jobs/
│   │   │       ├── audit-log/
│   │   │       ├── integrations/
│   │   │       ├── feature-flags/
│   │   │       └── platform/
│   │   ├── components/
│   │   ├── lib/
│   │   │   └── trpc.ts
│   │   ├── middleware.ts            # PLATFORM_ADMIN enforcement
│   │   ├── next.config.ts
│   │   └── package.json
│   │
│   └── workers/                    # BullMQ worker process
│       ├── src/
│       │   ├── index.ts            # Worker entry point, registers all workers
│       │   ├── workers/
│       │   │   ├── integration-sync.worker.ts
│       │   │   ├── webhook.worker.ts
│       │   │   ├── analytics-rollup.worker.ts
│       │   │   ├── token-refresh.worker.ts
│       │   │   ├── email.worker.ts
│       │   │   └── booking-expiry.worker.ts
│       │   └── lib/
│       │       └── logger.ts
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   ├── db/                         # Prisma — single source of DB truth
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # All models
│   │   │   ├── migrations/         # Migration files
│   │   │   └── seed.ts             # Dev seed data
│   │   ├── src/
│   │   │   ├── client.ts           # Prisma client singleton
│   │   │   ├── middleware/
│   │   │   │   ├── tenant-isolation.ts   # CRITICAL: injects tenant_id filter
│   │   │   │   └── audit-log.ts          # Auto-writes AuditLog on mutations
│   │   │   ├── helpers/            # Common query helpers
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── api/                        # tRPC routers and procedures
│   │   ├── src/
│   │   │   ├── trpc.ts             # tRPC init, context type, base procedures
│   │   │   ├── context.ts          # Request context builder
│   │   │   ├── routers/
│   │   │   │   ├── _app.ts         # Root router (merges all sub-routers)
│   │   │   │   ├── tenant.ts
│   │   │   │   ├── listing.ts
│   │   │   │   ├── booking.ts
│   │   │   │   ├── analytics.ts
│   │   │   │   ├── integration.ts
│   │   │   │   ├── team.ts
│   │   │   │   └── admin/
│   │   │   │       ├── _admin.ts   # Admin-only root router
│   │   │   │       ├── tenants.ts
│   │   │   │       ├── jobs.ts
│   │   │   │       ├── audit.ts
│   │   │   │       └── flags.ts
│   │   │   ├── middleware/
│   │   │   │   ├── require-auth.ts
│   │   │   │   ├── require-tenant.ts
│   │   │   │   ├── require-role.ts
│   │   │   │   └── require-platform-admin.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── auth/                       # Clerk wrappers, session helpers
│   │   ├── src/
│   │   │   ├── server.ts           # currentUser(), requireAuth() for server components
│   │   │   ├── client.ts           # useAuth(), useOrg() client hooks re-exports
│   │   │   ├── session.ts          # resolveSession() — builds tRPC context
│   │   │   ├── permissions.ts      # requireTenantRole(), requirePlatformAdmin()
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── ui/                         # Shared React components
│   │   ├── src/
│   │   │   ├── components/
│   │   │   │   ├── button.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── table.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── badge.tsx
│   │   │   │   └── ...             # shadcn/ui components configured here
│   │   │   ├── layouts/
│   │   │   │   ├── dashboard-shell.tsx
│   │   │   │   ├── admin-shell.tsx
│   │   │   │   └── page-header.tsx
│   │   │   └── index.ts
│   │   ├── tailwind.config.ts      # Shared Tailwind config (extended by apps)
│   │   └── package.json
│   │
│   ├── integrations/               # Integration adapter system
│   │   ├── src/
│   │   │   ├── types.ts            # IntegrationAdapter interface (canonical)
│   │   │   ├── registry.ts         # Provider registry map
│   │   │   ├── crypto.ts           # Credential encryption/decryption
│   │   │   ├── providers/
│   │   │   │   └── google-calendar/ # Example first provider
│   │   │   │       ├── adapter.ts
│   │   │   │       ├── mapper.ts
│   │   │   │       └── index.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── jobs/                       # BullMQ queue contracts
│   │   ├── src/
│   │   │   ├── queues.ts           # Queue names as constants
│   │   │   ├── types.ts            # Job payload type definitions per queue
│   │   │   ├── enqueue.ts          # enqueue() helper — safe job dispatch
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── analytics/                  # AnalyticsEvent emitter
│   │   ├── src/
│   │   │   ├── emit.ts             # emitEvent() server-side function
│   │   │   ├── events.ts           # All event type definitions and schemas
│   │   │   ├── posthog.ts          # PostHog server-side client
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── config/                     # Shared tooling configs
│       ├── typescript/
│       │   └── base.json           # Base tsconfig (strict mode)
│       ├── eslint/
│       │   └── base.js             # Base ESLint config
│       ├── env.ts                  # Zod schema for all env vars
│       └── package.json
│
├── docs/
│   ├── architecture.md             # Source of truth for architecture decisions
│   ├── implementation-plan.md      # This document
│   └── task-packets/               # Individual Codex task briefs live here
│       ├── TASK-001.md
│       └── ...
│
├── turbo.json                      # Turborepo pipeline config
├── pnpm-workspace.yaml
├── package.json                    # Root — no app code, only tooling
├── .env.example                    # Key names only, no values
├── .gitignore
└── README.md
```

---

## 3. Shared Engineering Conventions

These conventions apply to all packages and apps. Codex must follow them on every task. They are not suggestions.

### Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Files | `kebab-case` | `tenant-isolation.ts` |
| React components | `PascalCase` in `PascalCase.tsx` | `BookingCard.tsx` |
| tRPC routers | `camelCase`, noun describing the domain | `listingRouter` |
| tRPC procedures | `camelCase`, verb + noun | `getListings`, `createBooking` |
| Database tables | `snake_case` (Prisma maps to camelCase) | `tenant_membership` |
| Database columns | `snake_case` | `tenant_id`, `created_at` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `CLERK_SECRET_KEY` |
| Analytics events | `noun.verb` dot notation | `booking.created`, `listing.published` |
| BullMQ queue names | `kebab-case` | `integration-sync`, `email-dispatch` |
| Feature flag keys | `domain.feature` dot notation | `integrations.square`, `analytics.advanced` |
| Redis key namespaces | `tenant:{id}:{resource}` | `tenant:abc123:flags` |

### Shared Types

- All shared types live in `packages/db/src` (DB-derived types from Prisma) or `packages/api/src` (tRPC input/output types)
- Never redeclare a type in an app that already exists in a package
- `export type` only from packages — never `export default` for types
- Zod schemas for input validation live in `packages/api/src/routers/` next to the router that uses them
- Do not duplicate Zod schemas. If the same shape is needed in two routers, extract it to `packages/api/src/schemas/`

### API Response Shapes

All tRPC procedures return one of these shapes. No exceptions:

```typescript
// Success — single entity
{ data: T }

// Success — list
{ data: T[], total: number, page: number, pageSize: number }

// tRPC throws TRPCError on failure — no manual error envelopes
// Errors are caught by tRPC's error formatter, not by manual wrapping
```

Do not add `{ success: true, data: ... }` envelopes. tRPC handles errors via `throw new TRPCError(...)`.

### Validation

- All tRPC procedure inputs are validated with **Zod** in the `.input()` call — no exceptions
- Zod schemas are defined in the same file as the router that uses them, unless shared
- Client-side forms use **react-hook-form** with `zodResolver` — the same Zod schema from the API is reused via package import
- Never validate only on the client — all validation must exist server-side
- Strip unknown fields: use `.strict()` on Zod objects for mutation inputs

### Error Handling

- tRPC procedures throw `TRPCError` with appropriate codes: `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `BAD_REQUEST`, `INTERNAL_SERVER_ERROR`
- Never throw raw `Error` objects from procedures — always `TRPCError`
- Expected errors (not found, forbidden) use the code; unexpected errors are caught and logged before re-throwing as `INTERNAL_SERVER_ERROR`
- Error messages in `TRPCError` are safe to display to users — do not include stack traces or DB details in the message
- All `catch` blocks in worker jobs must log the error structurally and update the relevant `JobRecord`

### Auth and Permission Checks

This is the order of operations in every tRPC procedure that touches data:

1. `requireAuth` middleware verifies a valid Clerk session exists
2. `requireTenant` middleware resolves `activeTenantId` from the session org claim
3. `requireRole(ctx, 'MANAGER')` (or appropriate minimum role) is called before any logic
4. Resource-level check: `if (entity.tenantId !== ctx.activeTenantId) throw new TRPCError({ code: 'FORBIDDEN' })`
5. Only then does business logic execute

Admin procedures replace steps 2–4 with `requirePlatformAdmin(ctx)`.

**Do not** put permission checks in React components. Components receive already-filtered data.

### Database Access

- All DB access goes through `packages/db/src/client.ts` — import `{ db }` from `@pathfinder/db`
- Never instantiate `new PrismaClient()` in an app or other package
- Never use `db.$queryRaw` unless there is a documented reason and it includes an explicit `tenant_id` bind parameter
- The tenant isolation middleware in `packages/db` is always active on the `db` client — do not bypass it
- Migrations are run from `packages/db` only: `pnpm db:migrate`
- Seed data is only for the `development` environment

### Logging

Every log call must be structured JSON. Use the shared logger from `packages/config/src/logger.ts`:

```typescript
logger.info({ tenantId, userId, action: 'booking.created', bookingId })
logger.error({ tenantId, error: err.message, stack: err.stack, jobType })
```

Rules:
- Never log PII (email, name, phone number) — log IDs only
- Never log credential fields — if you must log a credentials object, log only the keys present, not values
- Every log line at `warn` or above must include `tenantId` (if applicable) and `action`
- In workers, every job start and completion is logged at `info`

### Analytics Event Naming

Events follow `noun.verb` format, past tense verb:

```
booking.created       booking.confirmed       booking.cancelled
listing.created       listing.published       listing.archived
event.created         event.cancelled
integration.connected integration.synced      integration.error
member.invited        member.joined           member.removed
session.started       (PostHog only)
```

`emitEvent()` from `packages/analytics` is called **server-side only** — never from client components. It accepts the event type and a typed properties object. New event types require adding a definition to `packages/analytics/src/events.ts` before emitting them.

### Feature Flags

- Use `featureEnabled(tenantId, 'flag.key')` from `packages/auth/src/permissions.ts`
- This function hits a cached Redis key (`tenant:{id}:flags`) — not a live DB query on every request
- Flag cache TTL is 60 seconds. Changes in admin console invalidate the cache immediately
- Never gate features with hardcoded strings in components. Always use `featureEnabled()`
- Feature flag keys must be defined in a central enum in `packages/config/src/feature-flags.ts`

### Testing

- **Unit tests**: `*.test.ts` next to the file being tested
- **Integration tests**: `*.integration.test.ts` — require a live test DB (separate from dev DB)
- **E2E tests**: in `apps/{app}/e2e/*.spec.ts` using Playwright
- Test file naming mirrors source file: `tenant-isolation.ts` → `tenant-isolation.test.ts`
- The tenant isolation middleware must have 100% branch coverage — this is a CI gate
- Every tRPC procedure must have at least one test for the `FORBIDDEN` path (wrong tenant)
- Use Vitest's `vi.mock()` sparingly — prefer test databases over mocking DB calls

### UI / Component Reuse

- Before creating a new component in `apps/dashboard/components/`, check if it belongs in `packages/ui`
- A component belongs in `packages/ui` if it is used (or likely to be used) in more than one app
- `packages/ui` components must be headless-first (shadcn/ui model) — styles applied via className, not hardcoded
- Do not import from `apps/*` in UI components
- Icons: use `lucide-react` only — no other icon libraries

### Package Addition Policy

- New packages require justification in the PR description
- Before adding a new package, check if `packages/config` already provides the capability
- `devDependencies` go in the workspace root `package.json` for shared tooling, in the specific package for package-specific tools
- Never add a runtime dependency to `packages/config` — it must stay as a pure config package
- Lock file (`pnpm-lock.yaml`) must always be committed

---

## 4. Core Module Contracts

### Auth (`packages/auth`)

**Purpose:** Abstract all Clerk interaction. Provide session resolution and permission guards to the rest of the platform.

**Allowed responsibilities:**
- Resolve the current user from a Clerk session
- Resolve the active tenant ID from the Clerk org claim
- Provide `requireAuth`, `requireTenantRole`, `requirePlatformAdmin` guards
- Re-export Clerk client-side hooks for app use

**Forbidden responsibilities:**
- No database queries (cannot import `packages/db`)
- No business logic
- No tRPC router definitions

**Dependencies:** `@clerk/nextjs`, `packages/config`

**Stable interface:**
```typescript
// Server
resolveSession(request): Promise<SessionContext>
requireAuth(ctx): asserts ctx is AuthenticatedContext
requireTenantRole(ctx, tenantId, minRole: TenantRole): void   // throws FORBIDDEN
requirePlatformAdmin(ctx): void                               // throws FORBIDDEN

// Client re-exports (thin wrappers)
useSession()
useOrganization()
```

---

### Tenant/Org Access (`packages/api/src/routers/tenant.ts` + middleware)

**Purpose:** Resolve which tenant is active for a request, enforce that the caller is a member of that tenant, and provide tenant-level data reads.

**Allowed responsibilities:**
- Resolve `activeTenantId` from session
- CRUD for `Tenant` entity (create during onboarding, update settings)
- Read `TenantMembership` for the active tenant
- Provide `ctx.activeTenantId` and `ctx.callerRole` to downstream procedures

**Forbidden responsibilities:**
- Cannot bypass tenant isolation to read other tenants' data
- Cannot modify feature flags (admin only)
- Cannot grant platform-admin role

**Dependencies:** `packages/auth`, `packages/db`

**Stable interface:**
```typescript
// tRPC procedures (tenant router)
tenant.getCurrent()             // returns active tenant details
tenant.update(input)            // update settings, OWNER only
tenant.getMembers()             // list memberships
tenant.inviteMember(input)      // OWNER only
tenant.removeMember(input)      // OWNER only
```

---

### DB Layer (`packages/db`)

**Purpose:** Single point of Prisma client access with tenant isolation and audit logging baked in.

**Allowed responsibilities:**
- Export the configured Prisma client (`db`)
- Apply tenant isolation middleware (appends `tenant_id` where clause)
- Apply audit log middleware (writes `AuditLog` on mutations)
- Export all Prisma-generated types
- Own all migrations

**Forbidden responsibilities:**
- No business logic
- No HTTP calls
- No Clerk or auth imports
- Cannot be bypassed — every data access goes through `db`

**Dependencies:** `@prisma/client`, `packages/config`

**Stable interface:**
```typescript
import { db } from '@pathfinder/db'
// db is the Prisma client — use it directly with standard Prisma API
// Middleware is transparent — consumers do not configure it

import type { Tenant, Listing, Booking, ... } from '@pathfinder/db'
// All Prisma-generated types re-exported from this package
```

---

### Public Web App (`apps/web`)

**Purpose:** SSR/SSG public pages for end customers browsing tenant content and making bookings.

**Allowed responsibilities:**
- Render tenant listing pages (SSR, tenant-slug routing)
- Render booking/registration forms
- Call tRPC procedures scoped to public access (no auth required for reads)
- Write bookings and guest user records via authenticated tRPC procedures

**Forbidden responsibilities:**
- Cannot render any tenant staff data
- Cannot call admin tRPC procedures
- Cannot render cross-tenant content on any page
- No client-side auth except for optional guest user sessions

**Dependencies:** `packages/api`, `packages/ui`, `packages/auth` (read-only session)

---

### Company Dashboard (`apps/dashboard`)

**Purpose:** Authenticated SPA for tenant staff to manage their business on PathFinderOS.

**Allowed responsibilities:**
- All tenant-scoped CRUD operations via tRPC
- Analytics views for the authenticated tenant
- Integration management
- Team management

**Forbidden responsibilities:**
- Cannot call admin tRPC router
- Cannot read cross-tenant data
- Cannot modify `TenantFeatureFlag` (read only — feature gating is enforced, not managed)
- Cannot access `IntegrationConnection.credentials` field — backend never returns it

**Dependencies:** `packages/api`, `packages/ui`, `packages/auth`

---

### Admin Console (`apps/admin`)

**Purpose:** Platform owner operational interface.

**Allowed responsibilities:**
- Read all tenant data for support purposes
- Manage feature flags, plan tiers
- Trigger/repair integration jobs
- View audit logs platform-wide
- Create and manage impersonation sessions

**Forbidden responsibilities:**
- Cannot modify tenant business data directly (bookings, listings) — support is read-only except for admin-specific actions
- Cannot impersonate another platform admin
- All writes must produce an `AuditLog` entry — the admin middleware enforces this

**Dependencies:** `packages/api` (admin sub-router only), `packages/ui`, `packages/auth`

---

### Analytics (`packages/analytics`)

**Purpose:** Emit business analytics events server-side and provide PostHog integration.

**Allowed responsibilities:**
- Define all `AnalyticsEvent` types with required properties
- Provide `emitEvent(tenantId, type, properties)` that writes to the `analytics_events` table
- Provide PostHog server-side client for product analytics
- Define the analytics event type registry

**Forbidden responsibilities:**
- Never called from client components — server-side only
- Cannot query/aggregate events (queries are in `packages/api/src/routers/analytics.ts`)
- Cannot modify or delete events

**Dependencies:** `packages/db`, `packages/config`

---

### Integrations (`packages/integrations`)

**Purpose:** Define the adapter interface and own all provider implementations.

**Allowed responsibilities:**
- Define `IntegrationAdapter` interface (canonical, frozen)
- Own credential encryption/decryption
- Implement individual provider adapters
- Maintain the provider registry

**Forbidden responsibilities:**
- Cannot enqueue jobs (that is `packages/jobs` responsibility)
- Cannot directly modify `IntegrationConnection` rows — that is done by the sync workers via `packages/db`
- Cannot make synchronous calls during a web request — adapters are called from workers only
- Cannot import from `packages/api`

**Dependencies:** `packages/db` (types only), `packages/config`

---

### Background Jobs (`packages/jobs` + `apps/workers`)

**Purpose:** `packages/jobs` defines queue contracts. `apps/workers` implements workers.

**Allowed responsibilities of `packages/jobs`:**
- Export queue name constants
- Export typed job payload interfaces for each queue
- Export `enqueue(queue, payload)` helper (safe dispatch from any package)

**Allowed responsibilities of `apps/workers`:**
- Import and run BullMQ workers
- Call integration adapters, email sending, analytics rollup
- Write `JobRecord` on completion/failure
- Call `emitEvent()` on significant job outcomes

**Forbidden responsibilities:**
- `packages/jobs` must not import BullMQ directly (just the types/contracts)
- Workers must not serve HTTP traffic
- Workers must not expose tRPC procedures

**Dependencies:** `packages/db`, `packages/integrations`, `packages/analytics`, `packages/config`

---

### Notifications (`apps/workers` email worker)

**Purpose:** Transactional email dispatch via Resend (or SendGrid).

**Allowed responsibilities:**
- Send booking confirmation emails
- Send team invitation emails
- Send integration error alerts to tenant owners

**Forbidden responsibilities:**
- Never send emails synchronously in a web request
- Never send marketing or bulk email
- Email content templates live in `apps/workers/src/templates/` — not in packages

**Dependencies:** `packages/jobs` (for enqueue), `packages/db`, Resend SDK

---

## 5. Database Implementation Plan

### Migration Order

Migrations must be applied in this order. Each migration depends on the tables defined before it.

**Migration 001 — Identity Foundation**
```
users
tenants
tenant_memberships
```
- `users.id` = Clerk user ID (varchar, not uuid — Clerk issues its own IDs)
- `tenants.id` = Clerk org ID (varchar)
- `tenant_memberships` has FK to both; role stored as enum `OWNER | MANAGER | STAFF`

**Migration 002 — Platform Controls**
```
tenant_feature_flags
platform_config
audit_logs
```
- `audit_logs` has no FKs except soft reference to `tenants.id` (nullable, for platform-level actions)
- `audit_logs` has a partial index on `(tenant_id, created_at)` for dashboard queries

**Migration 003 — Business Domain Core**
```
listings
events
guest_users
bookings
```
- All tables have `tenant_id` NOT NULL FK to `tenants.id`
- `bookings.guest_user_id` FK to `guest_users.id`
- `bookings.listing_id` FK to `listings.id`
- `events.listing_id` FK to `listings.id`
- `guest_users` scoped to tenant — `(tenant_id, email)` unique constraint

**Migration 004 — Analytics**
```
analytics_events
```
- `analytics_events` is append-only; no FKs except `tenant_id`
- Partitioned by month in production (apply partition DDL after MVP)
- Index on `(tenant_id, event_type, occurred_at)`

**Migration 005 — Integration Framework**
```
integration_connections
integration_sync_logs
integration_webhook_events
```
- `integration_connections.credentials` stored as bytea (encrypted blob, not JSON)
- Index on `(tenant_id, provider, status)` for dashboard queries

**Migration 006 — Job Tracking**
```
job_records
```
- `job_records.tenant_id` nullable (platform jobs have no tenant)
- Index on `(status, created_at)` for admin queue views

**Migration 007 — Deferred (post-MVP)**
```
availability_slots
locations
daily_rollups
report_snapshots
admin_impersonation_sessions
platform_announcements
```

### Required Relationships Summary

```
users (1) ──── (many) tenant_memberships (many) ──── (1) tenants
tenants (1) ──── (many) listings
listings (1) ──── (many) events
listings (1) ──── (many) bookings
events (1) ──── (many) bookings
guest_users (1) ──── (many) bookings
tenants (1) ──── (many) integration_connections
integration_connections (1) ──── (many) integration_sync_logs
integration_connections (1) ──── (many) integration_webhook_events
```

### Indexes and Constraints

Required at migration time:

| Table | Index |
|-------|-------|
| `tenant_memberships` | UNIQUE `(tenant_id, user_id)` |
| `guest_users` | UNIQUE `(tenant_id, email)` |
| `listings` | INDEX `(tenant_id, status)` |
| `bookings` | INDEX `(tenant_id, status, created_at)` |
| `analytics_events` | INDEX `(tenant_id, event_type, occurred_at)` |
| `audit_logs` | INDEX `(tenant_id, created_at)` |
| `integration_connections` | UNIQUE `(tenant_id, provider)` |
| `job_records` | INDEX `(status, created_at)` |

### Tenancy Rules (enforced in Prisma middleware)

The following tables are **tenanted** — every query against them must include `tenant_id`:

```
tenants (is the tenant — no filter needed, but access is by ID)
tenant_memberships
tenant_feature_flags
listings
events
guest_users
bookings
analytics_events
integration_connections
integration_sync_logs
integration_webhook_events
job_records (nullable — platform jobs exempt)
```

The following tables are **platform-level** — no tenant filter:

```
users
audit_logs
platform_config
job_records (where tenant_id IS NULL)
```

### Audit Logging Rules

The Prisma `audit-log` middleware intercepts mutations and writes `AuditLog` automatically for:
- Any `create` on: `listings`, `events`, `bookings`, `integration_connections`, `tenant_memberships`
- Any `update` on the above, plus `tenants`, `tenant_feature_flags`
- Any `delete` on any tenanted table

The middleware captures `before_state` (from a pre-read) and `after_state` from the mutation result. This adds one read per audited mutation — acceptable at MVP scale.

---

## 6. Routes and Screens Plan

### Public Web App (`apps/web`)

| Route | Purpose | Required Data | Auth | MVP? |
|-------|---------|--------------|------|------|
| `/` | Platform root (redirect or landing) | None | None | Now |
| `/[tenantSlug]` | Tenant homepage | `Tenant`, published `Listing[]` | None | Now |
| `/[tenantSlug]/listings` | All listings for tenant | `Listing[]` | None | Now |
| `/[tenantSlug]/listings/[id]` | Listing detail page | `Listing`, `Event[]` | None | Now |
| `/[tenantSlug]/book/[listingId]` | Booking form | `Listing`, `AvailabilitySlot[]` | None (guest) | Now |
| `/[tenantSlug]/book/[listingId]/confirm` | Booking confirmation | `Booking` | None | Now |
| `/[tenantSlug]/events` | Event list for tenant | `Event[]` | None | Soon |
| `/[tenantSlug]/events/[id]` | Event detail | `Event`, `Listing` | None | Soon |

**Tenant resolution in public app:** middleware reads `tenantSlug` from URL params, queries `tenants` by slug, sets tenant context for the request. If slug not found: 404.

---

### Company Dashboard (`apps/dashboard`)

| Route | Purpose | Required Data | Auth | MVP? |
|-------|---------|--------------|------|------|
| `/sign-in` | Clerk hosted sign-in | — | None | Now |
| `/sign-up` | Clerk hosted sign-up | — | None | Now |
| `/onboarding` | New tenant setup flow | `Tenant` (creating) | Auth | Now |
| `/` | Dashboard home / redirect | — | Auth + Tenant | Now |
| `/listings` | Listing list view | `Listing[]` | Auth + STAFF | Now |
| `/listings/new` | Create listing form | — | Auth + MANAGER | Now |
| `/listings/[id]` | Edit listing | `Listing` | Auth + MANAGER | Now |
| `/bookings` | Booking list | `Booking[]`, `GuestUser[]` | Auth + STAFF | Now |
| `/bookings/[id]` | Booking detail | `Booking`, `GuestUser` | Auth + STAFF | Now |
| `/analytics` | Analytics overview | `DailyRollup[]`, recent events | Auth + MANAGER | Soon |
| `/integrations` | Integration list | `IntegrationConnection[]` | Auth + OWNER | Soon |
| `/integrations/[provider]/connect` | OAuth connect flow | — | Auth + OWNER | Soon |
| `/integrations/[id]` | Integration detail/status | `IntegrationConnection`, `SyncLog[]` | Auth + MANAGER | Soon |
| `/team` | Team member list | `TenantMembership[]` | Auth + OWNER | Now |
| `/team/invite` | Invite team member | — | Auth + OWNER | Now |
| `/settings` | Tenant settings | `Tenant` config | Auth + OWNER | Now |

---

### Admin Console (`apps/admin`)

| Route | Purpose | Required Data | Auth | MVP? |
|-------|---------|--------------|------|------|
| `/sign-in` | Admin-only sign-in | — | None | Now |
| `/` | Platform overview | Tenant count, job health, error rate | PLATFORM_ADMIN | Now |
| `/tenants` | All tenants list | `Tenant[]` with status | PLATFORM_ADMIN | Now |
| `/tenants/[id]` | Tenant detail + support view | All tenant data | PLATFORM_ADMIN | Now |
| `/tenants/[id]/impersonate` | Start impersonation session | `AdminImpersonationSession` | PLATFORM_ADMIN | Soon |
| `/tenants/[id]/flags` | Manage feature flags for tenant | `TenantFeatureFlag[]` | PLATFORM_ADMIN | Now |
| `/jobs` | Job queue overview | `JobRecord[]`, queue stats | PLATFORM_ADMIN | Now |
| `/jobs/[id]` | Job detail + re-enqueue | `JobRecord` | PLATFORM_ADMIN | Now |
| `/audit-log` | Platform-wide audit log | `AuditLog[]` | PLATFORM_ADMIN | Now |
| `/integrations` | Platform-wide integration health | `IntegrationConnection[]` errors | PLATFORM_ADMIN | Soon |
| `/platform/config` | Platform config key/value | `PlatformConfig[]` | PLATFORM_ADMIN | Now |
| `/platform/announcements` | Manage announcements | `PlatformAnnouncement[]` | PLATFORM_ADMIN | Later |

---

## 7. Backend / API Plan

### Route Groupings

The tRPC root router (`packages/api/src/routers/_app.ts`) merges these sub-routers:

```
appRouter
├── tenant.*         # Tenant CRUD, settings, onboarding
├── listing.*        # Listing CRUD, publish/archive
├── booking.*        # Booking create/cancel/list
├── analytics.*      # Read analytics events and rollups for tenant
├── integration.*    # Connection management, sync status
├── team.*           # Member list, invite, remove
└── admin.*          # Admin sub-router (requires PLATFORM_ADMIN)
    ├── admin.tenants.*
    ├── admin.jobs.*
    ├── admin.audit.*
    └── admin.flags.*
```

Webhook ingestion uses **plain Next.js API routes** (not tRPC), located in each app:
- `apps/web/app/api/webhooks/clerk/route.ts` — Clerk webhook (membership sync)
- `apps/web/app/api/webhooks/[provider]/[connectionId]/route.ts` — Integration webhooks

### Validation Location

- Input validation: Zod schema in `.input()` of tRPC procedure — always server-side
- The same schema is importable by the frontend for form validation
- No validation in React components — `zodResolver` calls the same schema

### Authorization Location

Authorization is enforced in this exact order within tRPC procedures:

1. Auth middleware (`requireAuth`) — session must exist
2. Tenant middleware (`requireTenant`) — active tenant resolved
3. Role check (`requireRole(ctx, minRole)`) — caller has sufficient role
4. Resource ownership check — entity's `tenantId === ctx.activeTenantId`

Admin procedures skip steps 2–4 and use `requirePlatformAdmin(ctx)` instead.

### Sync vs Async Responsibilities

**Synchronous (returns in the HTTP response):**
- All reads (tenant, listing, booking, analytics)
- Booking creation (create record, emit event — both are fast)
- Integration connection (save credentials, return status)
- Feature flag checks

**Asynchronous (enqueue a job, return immediately):**
- Integration sync execution
- Webhook processing
- Email dispatch
- Analytics rollup computation
- Report generation

tRPC mutation that triggers async work returns `{ jobId: string }` — never blocks on job completion.

### Admin-Only Actions

These tRPC procedures are in the `admin.*` sub-router and require `PLATFORM_ADMIN`:

- `admin.tenants.list` — all tenants, any filter
- `admin.tenants.getById` — full tenant data
- `admin.tenants.updateStatus` — suspend/activate
- `admin.flags.set` — set feature flag for tenant
- `admin.jobs.list` — all job records with filters
- `admin.jobs.requeue` — re-enqueue a failed job
- `admin.audit.list` — audit log with tenant filter
- `admin.integrations.forceSync` — trigger sync for any connection

---

## 8. Integration System Implementation Plan

### Provider Registry

`packages/integrations/src/registry.ts` exports a map:

```typescript
const integrationRegistry: Record<string, IntegrationAdapter> = {
  'google-calendar': new GoogleCalendarAdapter(),
  // future: 'square': new SquareAdapter(),
}

function getAdapter(provider: string): IntegrationAdapter {
  const adapter = integrationRegistry[provider]
  if (!adapter) throw new Error(`Unknown integration provider: ${provider}`)
  return adapter
}
```

Adding a new provider = add one entry to this map. No other changes required.

### Adapter Contract

The `IntegrationAdapter` interface is defined in `packages/integrations/src/types.ts` and is **frozen** — do not modify without architectural review:

```typescript
interface IntegrationAdapter {
  readonly provider: string
  readonly version: string

  connect(config: ConnectConfig): Promise<ConnectionResult>
  validateCredentials(credentials: Buffer): Promise<boolean>  // credentials are encrypted bytes
  sync(connection: ConnectionRow, resourceType: string, options: SyncOptions): Promise<SyncResult>
  handleWebhook(event: RawWebhookEvent, connection: ConnectionRow): Promise<WebhookResult>
  verifyWebhookSignature(rawBody: Buffer, headers: HeadersMap, secret: string): boolean
  mapToInternal<T>(providerRecord: unknown, resourceType: string): T
  disconnect(connection: ConnectionRow): Promise<void>
}
```

### Auth Connection Flow

**OAuth2 providers:**
1. Dashboard calls `integration.getConnectUrl({ provider })` → returns OAuth redirect URL
2. User redirected to provider; returns to `/integrations/[provider]/callback?code=...`
3. Next.js API route handles callback: exchanges code for tokens
4. Tokens encrypted via `packages/integrations/src/crypto.ts` using `INTEGRATION_ENCRYPTION_KEY` env var
5. `IntegrationConnection` row created with encrypted credentials and `status: active`
6. Initial sync job enqueued immediately

**API key providers:**
1. Dashboard shows a form for API key input
2. `integration.connect({ provider, apiKey })` tRPC mutation called
3. Key encrypted and stored; adapter's `validateCredentials()` called to verify before saving
4. Connection row created; initial sync enqueued

### Sync Pipeline

```
enqueue('integration-sync', { connectionId, tenantId, resourceType, syncType: 'full' | 'delta' })
  → worker picks up job
  → fetch IntegrationConnection from DB
  → decrypt credentials
  → call adapter.sync(connection, resourceType, options)
    → adapter pages through provider API
    → each page: upsert records via db (using external_id as dedup key)
  → write IntegrationSyncLog (success/partial/failed)
  → update IntegrationConnection.last_synced_at
  → emitEvent('integration.synced', { connectionId, tenantId, recordsProcessed })
```

Delta syncs store a `since` cursor in `IntegrationConnection.config` JSON and pass it as `options.since`.

### Webhook Ingestion

```
POST /api/webhooks/[provider]/[connectionId]
  → verify signature (synchronous, before DB read) → 401 if invalid
  → insert IntegrationWebhookEvent { status: 'received' }
  → return 200 immediately
  → (async) enqueue('webhook-process', { webhookEventId })

webhook-process worker:
  → fetch IntegrationWebhookEvent
  → fetch IntegrationConnection
  → call adapter.handleWebhook(event, connection)
  → update IntegrationWebhookEvent.status = 'processed' | 'failed'
  → write JobRecord
```

### Retry Behavior

BullMQ job options for integration queues:

```typescript
{
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 30_000,   // 30s initial, then 1m, 5m, 30m, 2h
  },
  removeOnComplete: false,   // keep for audit visibility
  removeOnFail: false,       // keep in dead-letter for admin
}
```

After 5 failures: `IntegrationConnection.status = 'error'`, `JobRecord.status = 'dead'`, tenant dashboard shows reconnect prompt.

### Health Monitoring

`apps/workers` exposes an HTTP health check on port 3001 (not internet-facing):

```
GET /health
→ { queues: { 'integration-sync': { waiting: 0, active: 1, failed: 3 }, ... } }
```

Admin console fetches this via `admin.jobs.getQueueHealth` tRPC procedure which proxies to the worker health endpoint.

### Admin Repair Tools

Admin console provides (via `admin.jobs.*` procedures):

- `admin.jobs.listFailed({ queue?, tenantId? })` — list dead-letter jobs
- `admin.jobs.requeue(jobRecordId)` — re-enqueue from dead-letter
- `admin.jobs.forceSync({ connectionId })` — skip delta, force full sync
- `admin.jobs.clearDead({ queue })` — bulk clear dead-letter (dangerous — confirm modal required)
- `admin.integrations.resetConnection(connectionId)` — set status back to active to force tenant reconnect prompt

All repair actions write to `AuditLog`.

---

## 9. Analytics Implementation Plan

### First Events to Emit (MVP, emit at launch)

These must be wired before any feature is considered complete:

| Event | Trigger | Required Properties |
|-------|---------|-------------------|
| `booking.created` | Booking tRPC mutation success | `bookingId`, `listingId`, `guestUserId`, `source` |
| `booking.cancelled` | Cancel mutation success | `bookingId`, `reason` |
| `listing.created` | Listing create mutation | `listingId`, `listingType` |
| `listing.published` | Status changed to published | `listingId`, `listingType` |
| `listing.archived` | Status changed to archived | `listingId` |
| `integration.connected` | Connection row created | `provider`, `connectionId` |
| `integration.synced` | Sync job completed | `connectionId`, `provider`, `recordsProcessed` |
| `integration.error` | Job dead-lettered | `connectionId`, `provider`, `errorCode` |
| `member.invited` | Invitation sent | `invitedUserId`, `role` |
| `member.joined` | Membership confirmed | `userId`, `role` |

### Required Event Properties (all events)

Every event row has these base fields (set by `emitEvent()`):

```typescript
{
  id: uuid
  tenant_id: string       // always set — never null for business events
  event_type: string      // the noun.verb key
  actor_id: string | null // user ID if triggered by a person; null for system jobs
  occurred_at: Date       // server time, UTC
  properties: JsonObject  // event-specific fields above
}
```

### First Company Dashboard Metrics

These are the initial analytics widgets on the dashboard home:

| Widget | Query | Source |
|--------|-------|--------|
| Bookings this week | COUNT from `analytics_events` where type=`booking.created` and occurred_at > -7d | `analytics_events` live |
| Active listings | COUNT from `listings` where status=`published` | OLTP (not analytics) |
| Recent bookings | Last 10 rows from `bookings` with guest name | OLTP |
| Integration status | `IntegrationConnection[]` with last_synced_at | OLTP |

Note: The first dashboard widgets query OLTP directly for MVP (small data). Migration to `DailyRollup` happens when query times degrade or when the rollup job is built (Phase 5).

### First Admin Console Metrics

| Widget | Query | Source |
|--------|-------|--------|
| Total tenants | COUNT `tenants` | OLTP |
| Active tenants (7d) | Tenants with activity in `analytics_events` | `analytics_events` |
| Failed jobs | COUNT `job_records` where status=`dead` | `job_records` |
| Integration errors | COUNT `integration_connections` where status=`error` | OLTP |
| New tenants (30d) | COUNT `tenants` where created_at > -30d | OLTP |

### What Can Wait

- `DailyRollup` table population (post-MVP)
- `ReportSnapshot` generation (post-MVP)
- PostHog server-side event capture (post-MVP — add PostHog JS snippet first)
- Funnel and retention analytics (later)
- Cross-tenant aggregate analytics for admin (later — use direct DB queries for MVP)

---

## 10. Epics and Task Graph

### Epic 1: Repo Foundation
Tasks: T001 → T004  
Category: Foundation  
Sensitivity: Architecture-sensitive  

### Epic 2: Auth and Tenancy
Tasks: T005 → T009  
Category: Foundation  
Sensitivity: Architecture-sensitive (highest risk)  

### Epic 3: DB Layer and Tenant Isolation
Tasks: T010 → T012  
Category: Foundation  
Sensitivity: Architecture-sensitive (critical security control)  

### Epic 4: API Layer Foundation
Tasks: T013 → T015  
Category: Foundation  
Sensitivity: Architecture-sensitive  

### Epic 5: Core Business Objects
Tasks: T016 → T020  
Category: MVP  
Sensitivity: Standard  

### Epic 6: Public Web App
Tasks: T021 → T023  
Category: MVP  
Sensitivity: Standard  

### Epic 7: Company Dashboard Shell
Tasks: T024 → T028  
Category: MVP  
Sensitivity: Standard  

### Epic 8: Admin Console Shell
Tasks: T029 → T031  
Category: MVP  
Sensitivity: Risky (impersonation, no bypass)  

### Epic 9: Background Job Infrastructure
Tasks: T032 → T034  
Category: MVP  
Sensitivity: Architecture-sensitive  

### Epic 10: Integration Framework
Tasks: T035 → T040  
Category: MVP  
Sensitivity: Architecture-sensitive  

### Epic 11: Analytics Foundation
Tasks: T041 → T043  
Category: MVP  
Sensitivity: Standard  

### Epic 12: Email and Notifications
Tasks: T044 → T045  
Category: MVP  
Sensitivity: Standard  

### Epic 13: Security and Rate Limits
Tasks: T046 → T048  
Category: MVP  
Sensitivity: Risky  

### Epic 14: E2E Tests and CI
Tasks: T049 → T050  
Category: MVP  
Sensitivity: Standard  

### Dependency Graph (simplified)

```
T001 (repo init)
  → T002 (tooling: TS, ESLint, Prettier, Husky)
    → T003 (packages/config)
      → T004 (CI pipeline)
        → T005 (packages/db schema + migration 001)
          → T006 (packages/auth)
            → T007 (Clerk webhook handler for membership sync)
              → T008 (tRPC context builder)
                → T009 (tenant isolation middleware + tests)
                  → T010 (migration 002: platform controls + audit log)
                    → T011 (migration 003: business domain)
                      → T012 (migration 004: analytics_events)
                        → T013 (tRPC root router + requireAuth)
                          → T014 (tenant router)
                            → T015 (listing router + CRUD)
                              → T016 (booking router)
                                → T017 (public web app: listing pages)
                                  → T018 (public web app: booking form)
                                → T019 (dashboard shell + auth gate)
                                  → T020 (dashboard: listings UI)
                                  → T021 (dashboard: bookings UI)
                          → T022 (admin console shell + PLATFORM_ADMIN gate)
                            → T023 (admin: tenant list + detail)
                        → T024 (analytics router + emitEvent wiring)
                          → T025 (dashboard: analytics widgets)
                    → T010b (migration 005: integrations)
                      → T026 (packages/integrations: types + registry)
                        → T027 (integration connection router)
                          → T028 (apps/workers: integration sync worker)
                            → T029 (first provider adapter: google-calendar)
```

---

## 11. First 25 Tasks in Exact Order

---

### T001 — Initialize Turborepo Monorepo

**Objective:** Create the repo skeleton. Every subsequent task builds on this.

**Files involved:**
- `/turbo.json`
- `/pnpm-workspace.yaml`
- `/package.json` (root)
- `/.gitignore`
- `/.env.example`
- `apps/web/package.json`, `apps/dashboard/package.json`, `apps/admin/package.json`, `apps/workers/package.json`
- `packages/db/package.json`, `packages/api/package.json`, `packages/auth/package.json`, `packages/ui/package.json`, `packages/integrations/package.json`, `packages/jobs/package.json`, `packages/analytics/package.json`, `packages/config/package.json`

**Prerequisites:** None

**Definition of done:**
- `pnpm install` succeeds from repo root
- `turbo run build` runs without error (empty packages are fine at this stage)
- All workspace packages are listed in `pnpm-workspace.yaml`
- `.env.example` contains all required key names (see list below)
- No app code exists yet — only `package.json` files and placeholder `index.ts`

**Required env keys in `.env.example`:**
```
DATABASE_URL=
DIRECT_DATABASE_URL=
REDIS_URL=
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
CLERK_WEBHOOK_SECRET=
INTEGRATION_ENCRYPTION_KEY=
STORAGE_BUCKET=
STORAGE_REGION=
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
POSTHOG_API_KEY=
RESEND_API_KEY=
```

**Common mistakes to avoid:**
- Do not create a `node_modules` at the root unless using hoisting — pnpm handles this
- Do not add `"private": false` to internal packages — all packages should be `"private": true`
- Do not set up Next.js apps yet — just `package.json` and a placeholder `src/index.ts`

---

### T002 — Shared Tooling Configuration

**Objective:** Configure TypeScript strict mode, ESLint, Prettier, and Husky across the entire monorepo.

**Files involved:**
- `packages/config/typescript/base.json`
- `packages/config/typescript/nextjs.json`
- `packages/config/eslint/base.js`
- `packages/config/eslint/nextjs.js`
- `.prettierrc`
- `.husky/pre-commit`
- `packages/config/src/env.ts` — Zod schema for all environment variables

**Prerequisites:** T001

**Definition of done:**
- `tsc --noEmit` passes in all packages
- `eslint` passes with no warnings in a blank TypeScript file
- Prettier formats on commit via lint-staged
- `packages/config/src/env.ts` exports validated env object — any missing required var throws at startup, not at runtime
- `tsconfig.json` in every app extends `packages/config/typescript/nextjs.json`

**Common mistakes to avoid:**
- Do not use `"strict": false` anywhere — strict mode is non-negotiable
- Do not configure ESLint per-app from scratch — extend the shared base config
- `env.ts` must use `z.string().min(1)` for all required vars — `z.string()` allows empty strings

---

### T003 — Next.js App Scaffolding (All Three Apps)

**Objective:** Create working Next.js 14 App Router apps for `web`, `dashboard`, and `admin` with Clerk middleware installed.

**Files involved:**
- `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`
- `apps/web/next.config.ts`, `apps/web/middleware.ts`
- Same structure for `apps/dashboard` and `apps/admin`
- Clerk provider in each app's root `layout.tsx`

**Prerequisites:** T001, T002

**Definition of done:**
- All three apps start with `pnpm dev` without errors
- Clerk `<ClerkProvider>` wraps each app's root layout
- `middleware.ts` in each app uses Clerk's `authMiddleware` (or `clerkMiddleware` for v5+)
- `apps/admin/middleware.ts` redirects to `/sign-in` for any unauthenticated request — no public routes except sign-in
- `apps/dashboard/middleware.ts` protects `/(app)` routes, allows `/(auth)` routes
- `apps/web/middleware.ts` is public — rate limiting only (no auth requirement)
- Each app has its own Vercel project (documented in README, not necessarily connected yet)

**Common mistakes to avoid:**
- Do not use the Pages Router — App Router only
- Do not put Clerk's `<SignIn>` component on a shared layout — it belongs in `/(auth)` route groups
- `apps/admin` must have zero publicly accessible routes except `/sign-in` — this is enforced in middleware, not just the UI

---

### T004 — CI Pipeline

**Objective:** GitHub Actions CI runs typecheck, lint, and tests on every PR. No code merges without passing CI.

**Files involved:**
- `.github/workflows/ci.yml`

**Prerequisites:** T001, T002

**Definition of done:**
- CI runs on `push` to any branch and on `pull_request` to `main`
- Steps: `pnpm install` → `turbo run typecheck` → `turbo run lint` → `turbo run test`
- CI fails if any step fails
- Turbo remote caching is configured (Vercel token) so repeated runs are fast
- Branch protection on `main` requires CI to pass before merge

**Common mistakes to avoid:**
- Do not skip `--frozen-lockfile` on `pnpm install` in CI — this ensures the lock file is committed
- Do not use `npm` or `yarn` commands in CI — `pnpm` only
- Cache the `~/.pnpm-store` in CI to speed up installs

---

### T005 — Prisma Schema: Identity Foundation (Migration 001)

**Objective:** Define the foundational identity tables and run the first migration.

**Files involved:**
- `packages/db/prisma/schema.prisma` — add `User`, `Tenant`, `TenantMembership` models
- `packages/db/prisma/migrations/001_identity_foundation/`
- `packages/db/src/client.ts` — Prisma client singleton

**Prerequisites:** T002, DATABASE_URL env var set

**Definition of done:**
- `pnpm db:migrate` runs cleanly against a fresh PostgreSQL database
- `pnpm db:generate` produces Prisma types
- `packages/db/src/client.ts` exports a singleton `db` — uses `global` object pattern to avoid multiple instances in dev hot-reload
- `User.id` and `Tenant.id` are `String` (not `Int` or auto-UUID) — Clerk IDs are the source
- `TenantMembership.role` is a Prisma enum: `OWNER`, `MANAGER`, `STAFF`
- All three types are exported from `packages/db/src/index.ts`

**Common mistakes to avoid:**
- Do not use `@default(uuid())` on `User.id` or `Tenant.id` — these IDs come from Clerk, not Prisma
- Do not create `createdAt` as `DateTime @default(now())` without also adding `updatedAt @updatedAt` on mutable tables
- Singleton pattern: check `global.prisma` before instantiating — in Next.js dev, hot reload creates multiple instances

---

### T006 — Prisma Schema: Platform Controls (Migration 002)

**Objective:** Add `AuditLog`, `TenantFeatureFlag`, and `PlatformConfig` tables.

**Files involved:**
- `packages/db/prisma/schema.prisma` — add three models
- `packages/db/prisma/migrations/002_platform_controls/`
- `packages/db/src/helpers/audit.ts` — `writeAuditLog()` helper function

**Prerequisites:** T005

**Definition of done:**
- Migration runs cleanly
- `AuditLog` has no updatable fields — only `created_at` (no `updated_at`)
- `writeAuditLog(params)` helper accepts typed params and creates the record
- `TenantFeatureFlag` has a UNIQUE constraint on `(tenant_id, flag_key)`
- `featureEnabled(tenantId, flagKey)` helper exported from `packages/db/src/helpers/feature-flags.ts` — queries DB (caching added later)

**Common mistakes to avoid:**
- `AuditLog` must not have `@updatedAt` — it is append-only
- `AuditLog.before_state` and `after_state` are `Json?` (nullable) — not all actions have both
- Do not add a FK from `AuditLog.tenant_id` to `Tenant.id` — audit logs for deleted tenants must be retained

---

### T007 — Tenant Isolation Prisma Middleware

**Objective:** Implement and test the most critical security control in the platform.

**Files involved:**
- `packages/db/src/middleware/tenant-isolation.ts`
- `packages/db/src/middleware/tenant-isolation.test.ts`
- `packages/db/src/client.ts` — register middleware

**Prerequisites:** T005, T006

**Definition of done:**
- Middleware is a Prisma middleware (`.use()`) applied to the `db` client
- For any query on a tenanted table: if `where.tenant_id` is absent, middleware **throws** `TenantIsolationError`
- Platform-level tables (`users`, `audit_logs`, `platform_config`) are explicitly excluded from the check
- Admin bypass: a `bypassTenantIsolation` flag in context allows platform-admin queries (used only in admin procedures)
- Tests must cover:
  - Query with `tenant_id` passes ✓
  - Query without `tenant_id` on tenanted table throws ✓
  - Query on platform table without `tenant_id` passes ✓
  - Admin bypass flag allows cross-tenant query ✓
- Test file runs in CI; 100% branch coverage is a CI gate

**Common mistakes to avoid:**
- Throwing a generic `Error` is not sufficient — throw a typed `TenantIsolationError extends Error` so it can be caught specifically
- Do not check only `findMany` — check ALL operation types: `findFirst`, `findUnique`, `update`, `delete`, `create`
- The bypass flag must require explicit opt-in — not a default value that could be accidentally truthy

---

### T008 — packages/auth: Session Resolution and Permission Guards

**Objective:** Build the auth package that all apps and the API layer use.

**Files involved:**
- `packages/auth/src/server.ts`
- `packages/auth/src/session.ts`
- `packages/auth/src/permissions.ts`
- `packages/auth/src/index.ts`

**Prerequisites:** T003 (Clerk installed), T005

**Definition of done:**
- `resolveSession(request)` returns `{ userId, activeTenantId, role, isPlatformAdmin }` or throws `UNAUTHORIZED`
- `activeTenantId` is read from the Clerk JWT `org_id` claim — never from a request body or query param
- `isPlatformAdmin` is read from a Clerk public metadata field `platform_role: 'PLATFORM_ADMIN'` — set manually for the owner account
- `requireTenantRole(ctx, minRole)` compares `ctx.role` against the role hierarchy `STAFF < MANAGER < OWNER` and throws `TRPCError { code: 'FORBIDDEN' }` if insufficient
- `requirePlatformAdmin(ctx)` throws `TRPCError { code: 'FORBIDDEN' }` if `ctx.isPlatformAdmin !== true`
- Unit tests for all permission guard paths

**Common mistakes to avoid:**
- Do not read `activeTenantId` from the request URL or body — Clerk JWT org claim only
- `isPlatformAdmin` check must be `=== true` not truthy — metadata could contain unexpected values
- Role hierarchy must be a numeric comparison, not string equality — `OWNER > MANAGER > STAFF`

---

### T009 — tRPC API Layer Foundation

**Objective:** Set up tRPC with context resolution, base procedures, and middleware chain.

**Files involved:**
- `packages/api/src/trpc.ts`
- `packages/api/src/context.ts`
- `packages/api/src/middleware/require-auth.ts`
- `packages/api/src/middleware/require-tenant.ts`
- `packages/api/src/middleware/require-role.ts`
- `packages/api/src/middleware/require-platform-admin.ts`
- `packages/api/src/routers/_app.ts` (empty root router)
- `packages/api/src/index.ts`

**Prerequisites:** T008

**Definition of done:**
- tRPC context (`createTRPCContext`) calls `resolveSession()` and returns `{ db, session }`
- `publicProcedure` — no auth required
- `protectedProcedure` — applies `requireAuth` middleware
- `tenantProcedure` — extends `protectedProcedure`, applies `requireTenant` middleware
- `adminProcedure` — extends `protectedProcedure`, applies `requirePlatformAdmin` middleware
- Root router merges an empty `tenant`, `listing`, `booking`, `admin` sub-router (stubs for now)
- Each Next.js app has a `lib/trpc.ts` that creates the tRPC client using the correct base URL
- All three apps mount the router at `app/api/trpc/[trpc]/route.ts`

**Common mistakes to avoid:**
- Do not use a single `procedure` for everything — the four base procedures are used throughout the codebase
- `tenantProcedure` must set `ctx.activeTenantId` — downstream procedures must not resolve it themselves
- The tRPC handler in Next.js must use `fetchRequestHandler` not the old `createNextApiHandler`

---

### T010 — Clerk Webhook Handler (Membership Sync)

**Objective:** Keep the platform's `TenantMembership` table in sync with Clerk org memberships.

**Files involved:**
- `apps/dashboard/app/api/webhooks/clerk/route.ts`
- `packages/db/src/helpers/membership-sync.ts`

**Prerequisites:** T009, T006

**Definition of done:**
- Route handler verifies the Clerk webhook signature using `svix` package before processing
- Handles events: `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`
- On `created`: upserts `User` row, creates `TenantMembership` row with correct role
- On `updated`: updates role in `TenantMembership`
- On `deleted`: sets `TenantMembership.status = 'removed'` (soft delete — do not hard-delete)
- Writes an `AuditLog` entry for each membership change
- Returns `200` quickly — never throws from the handler (log errors, return 200 to avoid Clerk retrying)

**Common mistakes to avoid:**
- Do not skip signature verification — unsigned webhooks must return `401`
- Do not hard-delete `TenantMembership` rows — audit history requires the row
- Do not process the event synchronously before returning — if DB is slow, Clerk will retry and create duplicates. Use upsert with idempotency.

---

### T011 — Prisma Schema: Business Domain (Migration 003)

**Objective:** Add core business object tables.

**Files involved:**
- `packages/db/prisma/schema.prisma` — add `Listing`, `Event`, `GuestUser`, `Booking` models
- `packages/db/prisma/migrations/003_business_domain/`

**Prerequisites:** T007 (tenant isolation middleware must exist before adding tenanted tables)

**Definition of done:**
- All four models have `tenant_id String` with `@index`
- `Listing.status` is a Prisma enum: `DRAFT`, `PUBLISHED`, `ARCHIVED`
- `Booking.status` is a Prisma enum: `PENDING`, `CONFIRMED`, `CANCELLED`
- `Booking.source` is a Prisma enum: `WEB`, `IMPORT`, `INTEGRATION`
- `GuestUser` has UNIQUE constraint on `(tenant_id, email)`
- `Booking` has FK to `Listing`, optional FK to `Event`, FK to `GuestUser`
- Migration runs cleanly

**Common mistakes to avoid:**
- All FKs must specify `onDelete: Restrict` unless cascading is explicitly intended — prevent accidental data loss
- `Listing.images` is `Json` (array of storage keys) — do not create a separate `ListingImage` table for MVP
- `Booking` must not have a direct FK to `User` — bookings are from `GuestUser`, not staff

---

### T012 — Listing Router (CRUD Procedures)

**Objective:** First real tRPC router with full CRUD and permission enforcement.

**Files involved:**
- `packages/api/src/routers/listing.ts`
- `packages/api/src/routers/listing.test.ts`

**Prerequisites:** T009, T011

**Definition of done:**
- `listing.list` — `tenantProcedure`, returns `Listing[]` for active tenant (no cross-tenant data possible due to middleware)
- `listing.getById` — `tenantProcedure`, returns single listing; throws `NOT_FOUND` if not in tenant
- `listing.create` — `tenantProcedure`, `requireRole(MANAGER)`, Zod-validated input
- `listing.update` — `tenantProcedure`, `requireRole(MANAGER)`, validates ownership before update
- `listing.publish` — `tenantProcedure`, `requireRole(MANAGER)`, sets status to PUBLISHED, calls `emitEvent('listing.published')`
- `listing.archive` — `tenantProcedure`, `requireRole(MANAGER)`, sets status to ARCHIVED
- `listing.delete` — `tenantProcedure`, `requireRole(OWNER)` — soft delete (status = ARCHIVED) at MVP
- Tests: `FORBIDDEN` path for wrong tenant, role enforcement, `NOT_FOUND` for nonexistent ID

**Common mistakes to avoid:**
- `listing.getById` must verify `listing.tenantId === ctx.activeTenantId` even though Prisma middleware filters — defense in depth
- `emitEvent()` is called after the mutation succeeds, not before
- Do not return `credentials` or any field that should not be client-visible — use Prisma's `select` to whitelist returned fields

---

### T013 — Booking Router

**Objective:** Booking creation for the public app and management for the dashboard.

**Files involved:**
- `packages/api/src/routers/booking.ts`

**Prerequisites:** T012

**Definition of done:**
- `booking.create` — `publicProcedure` (guest users, no auth required), accepts `{ tenantId, listingId, guestEmail, guestName, notes }`, upserts `GuestUser`, creates `Booking`, calls `emitEvent('booking.created')`, enqueues email confirmation job
- `booking.list` — `tenantProcedure`, returns bookings for active tenant with pagination
- `booking.getById` — `tenantProcedure`, returns single booking with guest user data
- `booking.confirm` — `tenantProcedure`, `requireRole(MANAGER)`, sets status to CONFIRMED
- `booking.cancel` — `tenantProcedure`, `requireRole(STAFF)`, sets status to CANCELLED with reason, calls `emitEvent('booking.cancelled')`
- Zod validation on all inputs; `guestEmail` validated as email format

**Common mistakes to avoid:**
- `booking.create` is a `publicProcedure` — it takes `tenantId` as an input and the middleware must NOT apply tenant isolation from the session (guest has no session)
- However, the booking's `tenant_id` is set from the input `tenantId` which is validated against a real tenant — never trust it blindly: query `tenants` by ID to confirm it exists and is active
- `GuestUser` upsert must use `(tenant_id, email)` as the unique key — same email at different tenants is different records

---

### T014 — Prisma Schema: Analytics Events (Migration 004)

**Objective:** Lay down the analytics event table and wire `emitEvent()`.

**Files involved:**
- `packages/db/prisma/schema.prisma` — add `AnalyticsEvent` model
- `packages/db/prisma/migrations/004_analytics_events/`
- `packages/analytics/src/events.ts` — all event type definitions
- `packages/analytics/src/emit.ts` — `emitEvent()` implementation

**Prerequisites:** T007

**Definition of done:**
- `AnalyticsEvent` model has: `id`, `tenant_id`, `event_type`, `actor_id` (nullable), `occurred_at`, `properties` (Json)
- Index on `(tenant_id, event_type, occurred_at)`
- `emitEvent(tenantId, type, properties)` writes a row — does NOT throw if it fails (log error and continue — analytics must never break the main flow)
- All MVP event types defined in `events.ts` as a TypeScript union type
- `emitEvent()` is type-safe: the `properties` type is inferred from the `event_type`

**Common mistakes to avoid:**
- `emitEvent()` must be `try/catch`-wrapped internally — analytics failure must not surface as a 500 to the user
- Do not emit events from client components — server-side only
- `occurred_at` uses `new Date()` set by the server — never trust client timestamps

---

### T015 — Public Web App: Tenant Pages

**Objective:** Public users can view a tenant's listings via slug-based routing.

**Files involved:**
- `apps/web/app/[tenantSlug]/page.tsx`
- `apps/web/app/[tenantSlug]/listings/page.tsx`
- `apps/web/app/[tenantSlug]/listings/[id]/page.tsx`
- `apps/web/middleware.ts` — tenant slug resolution + rate limiting
- `apps/web/lib/trpc.ts` — tRPC server client for RSC

**Prerequisites:** T012, T013

**Definition of done:**
- `[tenantSlug]` pages use `generateStaticParams` for known tenants (ISR, revalidate 60s)
- If tenant slug not found: `notFound()` from Next.js
- Listing detail page renders name, description, status-appropriate CTA
- No tenant staff data visible on any public page
- Rate limiting in `middleware.ts`: 60 req/min per IP, using Upstash Redis rate limiter

**Common mistakes to avoid:**
- Do not fetch tenant data client-side on public pages — use RSC server components for SEO
- Do not show any admin or staff-facing fields on public pages (even if they are null)
- Rate limit must apply to all routes under `[tenantSlug]`, not just the homepage

---

### T016 — Public Web App: Booking Form

**Objective:** End users can create a booking from the public listing page.

**Files involved:**
- `apps/web/app/[tenantSlug]/book/[listingId]/page.tsx`
- `apps/web/app/[tenantSlug]/book/[listingId]/confirm/page.tsx`
- `apps/web/components/BookingForm.tsx`

**Prerequisites:** T013, T015

**Definition of done:**
- Form collects: guest name, email, optional notes
- Calls `booking.create` tRPC mutation
- On success: redirects to `/[tenantSlug]/book/[listingId]/confirm?bookingId=...`
- Confirmation page shows booking details (server-rendered, fetches by booking ID)
- Form uses `react-hook-form` + `zodResolver` with the same Zod schema from the API
- Client-side validation shows inline errors; server-side validation throws and is caught by tRPC error handler

**Common mistakes to avoid:**
- Do not store booking ID in localStorage — confirmation page uses URL param + server fetch
- Do not use `router.push()` before the mutation `await` resolves
- Confirmation page must not require auth — guest-accessible via booking ID in URL

---

### T017 — Dashboard Shell and Auth Gate

**Objective:** Dashboard app has a working shell with auth, tenant resolution, and navigation.

**Files involved:**
- `apps/dashboard/app/(app)/layout.tsx`
- `apps/dashboard/app/(app)/page.tsx` (redirect to /listings)
- `apps/dashboard/components/sidebar.tsx`
- `apps/dashboard/app/onboarding/page.tsx`

**Prerequisites:** T003, T009

**Definition of done:**
- `(app)/layout.tsx` uses Clerk's `auth()` to get `orgId`; if no org, redirects to `/onboarding`
- Onboarding creates a Clerk organization + `Tenant` DB row via `tenant.create` tRPC mutation
- Sidebar renders navigation links for: Listings, Bookings, Team, Settings
- Active tenant name displayed in sidebar header
- If user has no active org after completing onboarding: show org switcher

**Common mistakes to avoid:**
- Do not create the `Tenant` DB row before the Clerk org exists — Clerk org creation must succeed first
- Onboarding should not be accessible once a tenant exists — redirect to `/listings`
- Sidebar links use `next/link` — not `<a>` tags

---

### T018 — Dashboard: Listings UI

**Objective:** Tenant staff can view, create, edit, and publish listings from the dashboard.

**Files involved:**
- `apps/dashboard/app/(app)/listings/page.tsx`
- `apps/dashboard/app/(app)/listings/new/page.tsx`
- `apps/dashboard/app/(app)/listings/[id]/page.tsx`
- `apps/dashboard/components/listing-form.tsx`

**Prerequisites:** T017, T012

**Definition of done:**
- Listings page shows a table of all tenant listings with status badges
- Create/edit form has: name, description, type (select), status toggle
- Image upload UI calls a presigned URL endpoint then stores the key in `listing.images`
- Publish and archive actions show confirmation dialog before calling mutation
- MANAGER role required for create/edit — `STAFF` sees read-only view
- Role enforcement is handled server-side; UI hides action buttons based on role (cosmetic only — not security)

**Common mistakes to avoid:**
- Do not upload files directly to the API — use presigned URL pattern (browser → S3 directly)
- Role-based UI hiding is cosmetic only — the tRPC procedure enforces the actual role check
- Optimistic updates on status change — do not wait for page reload

---

### T019 — Dashboard: Bookings UI

**Objective:** Tenant staff can view and manage bookings.

**Files involved:**
- `apps/dashboard/app/(app)/bookings/page.tsx`
- `apps/dashboard/app/(app)/bookings/[id]/page.tsx`

**Prerequisites:** T017, T013

**Definition of done:**
- Bookings list with pagination, status filter, and guest name search
- Booking detail shows: guest info, listing, status, notes, creation source
- Confirm and cancel actions with confirmation dialog
- Cancel requires a reason (text input)
- `STAFF` role can cancel; `MANAGER` role can confirm

**Common mistakes to avoid:**
- Paginate from the API — never fetch all bookings client-side and filter in the browser
- Guest email shown in booking detail is PII — do not log it or send it to PostHog

---

### T020 — Admin Console Shell and PLATFORM_ADMIN Gate

**Objective:** Admin app has a working shell, hard-gated to platform admins only.

**Files involved:**
- `apps/admin/middleware.ts`
- `apps/admin/app/(app)/layout.tsx`
- `apps/admin/app/(app)/page.tsx`
- `apps/admin/components/admin-sidebar.tsx`

**Prerequisites:** T003, T009, T008

**Definition of done:**
- `apps/admin/middleware.ts` — every route except `/sign-in` requires auth AND `isPlatformAdmin === true`; non-admin authenticated users get a `403` page (not a redirect to dashboard)
- Admin shell shows: Tenants, Jobs, Audit Log, Platform navigation
- Homepage shows: total tenant count, failed job count (from `admin.jobs.getQueueHealth`)
- The `PLATFORM_ADMIN` claim is set in Clerk user public metadata — document the manual step to set this for the owner account

**Common mistakes to avoid:**
- Do not redirect non-admin users to the dashboard — show a `403` within the admin domain
- The `isPlatformAdmin` check must happen in middleware (edge) AND in the tRPC `adminProcedure` — two independent checks
- Do not deploy admin app on the same Vercel project as the dashboard — separate project, separate domain

---

### T021 — Admin Console: Tenant List and Detail

**Objective:** Platform owner can view all tenants and their operational state.

**Files involved:**
- `apps/admin/app/(app)/tenants/page.tsx`
- `apps/admin/app/(app)/tenants/[id]/page.tsx`
- `packages/api/src/routers/admin/tenants.ts`

**Prerequisites:** T020

**Definition of done:**
- Tenant list: ID, name, slug, plan_tier, status, created_at, booking count (last 30d)
- Tenant detail: all above + recent bookings, recent audit log entries, integration connections and their status
- `admin.tenants.list` procedure uses `bypassTenantIsolation` flag on DB queries
- `admin.tenants.updateStatus` allows suspending/activating tenants (OWNER only admin action)
- All admin reads produce an `AuditLog` entry with `action: 'admin.tenant.viewed'`

**Common mistakes to avoid:**
- Do not return integration credentials in the tenant detail response — return status fields only
- Audit log on admin views: actor is the admin user, not a tenant user — `tenant_id` in the log is the target tenant, not the admin's tenant

---

### T022 — Background Job Infrastructure

**Objective:** BullMQ workers app is runnable, with queue definitions and the email worker implemented.

**Files involved:**
- `packages/jobs/src/queues.ts`
- `packages/jobs/src/types.ts`
- `packages/jobs/src/enqueue.ts`
- `apps/workers/src/index.ts`
- `apps/workers/src/workers/email.worker.ts`
- `apps/workers/Dockerfile`

**Prerequisites:** T009, REDIS_URL configured

**Definition of done:**
- Queue names defined as constants in `packages/jobs/src/queues.ts`
- Typed payload interfaces for: `integration-sync`, `webhook-process`, `email-dispatch`, `analytics-rollup`, `booking-expiry`
- `enqueue(queue, payload)` helper validates payload type at compile time
- Email worker picks up `email-dispatch` jobs, sends via Resend
- Email templates (booking confirmation, team invitation) in `apps/workers/src/templates/`
- `JobRecord` written on every job completion and failure
- Worker process starts with `node dist/index.js` (not Next.js)
- Dockerfile builds the worker for Railway deployment

**Common mistakes to avoid:**
- Do not use `Bull` (v4) — use `BullMQ` (v5+) which has a different API
- `enqueue()` must not import from `bullmq` — it must use a lightweight HTTP or Redis call so it can be called from Next.js serverless functions
- Worker process must handle `SIGTERM` gracefully — close queues and drain in-flight jobs before exit

---

### T023 — Analytics Router and emitEvent Wiring

**Objective:** Analytics events are emitted on all MVP actions, and the dashboard analytics procedure works.

**Files involved:**
- `packages/api/src/routers/analytics.ts`
- Modifications to: `listing.ts`, `booking.ts` (add `emitEvent()` calls)

**Prerequisites:** T014, T012, T013

**Definition of done:**
- `analytics.getDashboardSummary` — `tenantProcedure`, returns:
  - Bookings created in last 7d (query `analytics_events`)
  - Published listings count (query `listings` OLTP)
  - Bookings created in last 30d by day (for a simple bar chart)
- `emitEvent()` called in: `listing.publish`, `listing.archive`, `listing.create`, `booking.create`, `booking.cancel`, `booking.confirm`
- Confirm events are written to DB by checking `analytics_events` in integration test

**Common mistakes to avoid:**
- Analytics router procedures must only query `analytics_events` or `listings`/`bookings` for counts — never for full record sets
- `emitEvent()` errors are caught internally — a failed analytics write must not cause the tRPC mutation to fail
- Do not add `emitEvent()` to read procedures — only mutations and significant state changes

---

### T024 — Team Router and Dashboard Team UI

**Objective:** Tenant owners can invite and manage their team members.

**Files involved:**
- `packages/api/src/routers/team.ts`
- `apps/dashboard/app/(app)/team/page.tsx`
- `apps/dashboard/app/(app)/team/invite/page.tsx`

**Prerequisites:** T017, T010

**Definition of done:**
- `team.list` — returns `TenantMembership[]` for active tenant with user details
- `team.invite` — `requireRole(OWNER)`, calls Clerk's org invitation API, writes audit log
- `team.updateRole` — `requireRole(OWNER)`, updates role in Clerk + `TenantMembership`
- `team.remove` — `requireRole(OWNER)`, removes from Clerk org, soft-deletes membership
- Team page shows member list with roles and invite button
- Invite form: email + role selector

**Common mistakes to avoid:**
- Clerk is the source of truth for membership — always write to Clerk first, then sync DB (or rely on the webhook from T010)
- Do not allow a tenant owner to remove themselves unless another OWNER exists — enforce this server-side

---

### T025 — Presigned Upload Endpoint and Storage Integration

**Objective:** Listing images can be uploaded directly to S3/R2 from the browser.

**Files involved:**
- `apps/dashboard/app/api/storage/presign/route.ts`
- `packages/config/src/storage.ts` — S3 client setup

**Prerequisites:** T018, STORAGE_* env vars configured

**Definition of done:**
- `POST /api/storage/presign` — authenticated (Clerk session required), returns `{ uploadUrl, key }` for a new S3 object
- Key format: `tenants/{tenantId}/listings/{uuid}.{ext}`
- Upload URL expires in 5 minutes
- After upload, key is included in the `listing.update` mutation call to store in `listing.images`
- File size limit enforced via S3 presigned URL conditions: 10MB max
- Content type restricted to `image/*`

**Common mistakes to avoid:**
- Validate that the requesting user belongs to the tenant matching the key prefix — prevent cross-tenant key creation
- Never return the S3 credentials — only the presigned URL
- Do not store the full S3 URL — store only the key and reconstruct the URL at render time using the CDN base URL

---

## 12. Guardrails for Coding Agents

These rules are absolute. Violating them requires explicit architect approval, documented in the PR.

**G01 — No direct Prisma import outside `packages/db`**  
Import `{ db }` from `@pathfinder/db`. Never `import { PrismaClient } from '@prisma/client'` in an app or other package.

**G02 — No tenant query without tenant_id**  
Every query against a tenanted table must include `where: { tenant_id: ctx.activeTenantId }`. The middleware enforces this, but do not rely on it as the only check — add explicit resource ownership verification in procedures.

**G03 — No permission checks in React components**  
Components receive pre-filtered data from tRPC. They may hide/show UI elements based on role for UX purposes only. Security enforcement is server-side only.

**G04 — No synchronous external API calls in web request path**  
Integration API calls, email sending, and anything that calls an external service must be enqueued as a job. The one exception is OAuth token exchange during connection flow — this is inherently synchronous.

**G05 — No new router patterns**  
All API procedures go in `packages/api/src/routers/`. Do not create standalone API routes for business logic. Plain Next.js routes are only for webhooks and file uploads.

**G06 — No inline SQL**  
Use Prisma's query builder API. `db.$queryRaw` requires a code comment explaining why and must include an explicit `tenant_id` bind parameter.

**G07 — emitEvent() server-side only**  
`emitEvent()` from `packages/analytics` is never called from a client component or from within a React Server Component that renders HTML. Call it from tRPC procedures and worker jobs only.

**G08 — Admin procedures only in `admin.*` sub-router**  
Any procedure requiring `PLATFORM_ADMIN` goes in `packages/api/src/routers/admin/`. A `tenantProcedure` that checks `isPlatformAdmin` internally is a violation.

**G09 — Integration credentials never returned to client**  
`IntegrationConnection.credentials` must never appear in any tRPC procedure response. Use Prisma `select` to explicitly exclude it.

**G10 — AuditLog on every admin write**  
Any admin console action that modifies data (feature flags, tenant status, job requeue) must call `writeAuditLog()` before returning. This is not optional.

**G11 — New event types registered before use**  
Before calling `emitEvent('new.event', ...)`, the event type must be defined in `packages/analytics/src/events.ts`. TypeScript will catch violations at compile time.

**G12 — No new packages without justification**  
Before adding a `npm` dependency, check if `packages/config` or an existing package already provides the capability. Adding `lodash` for a one-liner is not acceptable.

**G13 — Tests required for security-critical paths**  
Every new tRPC procedure must have a test for the forbidden path (wrong tenant, insufficient role). CI will not pass without them.

**G14 — Feature flags from the registry only**  
Feature flag keys are defined in `packages/config/src/feature-flags.ts`. Do not hardcode flag key strings in procedures or components.

---

## 13. Human Review Guidance

### Safe to Delegate to Codex Without Close Review

- UI components in `packages/ui` (stateless, no auth, no data)
- `apps/web` public listing pages (read-only, no sensitive data)
- Dashboard UI (listings, bookings views — visual only)
- Email templates in `apps/workers/src/templates/`
- Zod validation schemas for new procedures
- Analytics event wiring on existing procedures (adding `emitEvent()` calls)
- New analytics dashboard widgets (read-only, tenant-scoped)
- Migration files for post-MVP tables (`availability_slots`, `locations`)

### Requires Close Human Review

| Area | Why |
|------|-----|
| `packages/db/src/middleware/tenant-isolation.ts` | Any change to this file is a security risk. Review every line. |
| `packages/auth/src/permissions.ts` | Role hierarchy and platform admin check — easy to introduce bypass |
| `apps/admin/middleware.ts` | Admin gate enforcement — must be checked for bypassable edge cases |
| Any new `publicProcedure` | These are unauthenticated — verify no tenant data is exposed |
| `packages/integrations/src/crypto.ts` | Credential encryption — wrong implementation = plaintext credentials in DB |
| Any `$queryRaw` usage | Manual SQL bypasses Prisma middleware — must be audited |
| Webhook signature verification code | Incorrect implementation = unsigned webhooks accepted |
| Admin impersonation flow (T future) | Complex session scoping — easy to create an escalation path |
| Any change to `AuditLog` model | Adding `updatedAt` or soft-delete = violates append-only requirement |
| CI pipeline changes | Removing a CI check could let unreviewed code merge |

### What to Validate Before Merging Any Epic

After each epic, run this checklist manually:

- [ ] `turbo run typecheck` — zero errors
- [ ] `turbo run lint` — zero errors
- [ ] `turbo run test` — all tests pass including tenant isolation tests
- [ ] Cross-tenant test: authenticated as Tenant A, attempt to read Tenant B's listings — must return empty/403
- [ ] Platform admin test: authenticate as a non-admin user, attempt to call an `admin.*` procedure — must return 403
- [ ] No `console.log` with PII in merged code

---

## 14. Final Handoff

### Best Repo Starting Point

Initialize the repo with T001 and T002 completed before giving any task to Codex. The monorepo structure and tooling config must be correct and passing CI before any feature work begins. A wrong structure here causes every subsequent task to fight the scaffolding.

### Safest First Implementation Milestone

**"Auth works, tenant isolation is enforced, and the CI pipeline is green."**

This is the end of Epic 3 (T007). At this point:
- All three apps deploy
- A user can sign in and have a resolved tenant
- The Prisma middleware throws on any cross-tenant query
- CI enforces typecheck + lint + tests on every PR

Nothing built before this point can cause architectural drift because there is no business logic yet. Everything built after this point inherits correct foundations.

### Exact First Task for Codex

**Give Codex T001 — Initialize Turborepo Monorepo.**

Provide it the full text of T001 from Section 11 of this document, plus this context:

> You are building PathFinderOS, a multi-tenant SaaS platform. The architecture is defined in `/docs/architecture.md` and the implementation plan is in `/docs/implementation-plan.md`. Your first task is T001. Do not write any application logic. Your only goal is to create the correct monorepo skeleton. All packages should have placeholder `index.ts` files — no implementation yet. Follow the folder structure in Section 2 of the implementation plan exactly.

After T001 passes CI, give Codex T002, then T003, and so on in strict sequential order through T009 before allowing any parallelism. Tasks T001–T009 are the architectural foundation — they must be sequential and each one reviewed before the next begins.

Starting from T010 (business domain tables), tasks can begin to parallelize within an epic once their dependencies are met.

---

*End of implementation plan. Save this file at `/docs/implementation-plan.md` and commit it alongside `/docs/architecture.md` before any code is written.*
