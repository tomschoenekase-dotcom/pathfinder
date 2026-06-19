# PathFinder — Codebase Structure & How It All Works

> A whole-system walkthrough of the repository as it actually exists today.
> Generated as a read-only review — no code was changed to produce this document.
>
> **Important framing:** `docs/architecture.md` and `CLAUDE.md` describe an _intended_ generic
> multi-tenant SaaS platform (listings, bookings, events, an integration framework, etc.).
> The code that actually exists has **pivoted** to a narrower, shipped product: an **AI-powered,
> location-aware venue guide chatbot**. Many tables and rules from the architecture doc are
> aspirational or unbuilt. Where the two diverge, this document describes the _real code_ and
> flags the gap. Treat the architecture doc as design intent and the constitution (`CLAUDE.md`)
> as the rulebook the real code mostly follows.

---

## 1. What the product actually is

PathFinder is a SaaS where **venue operators** (museums, parks, attractions, campuses) sign up,
describe their venue and its **points of interest ("places")**, and get a public, mobile-friendly
**AI chat guide** their visitors use on their phones. A guest opens `/{venueSlug}/chat`, optionally
shares their location, and asks questions like "where's the nearest bathroom?" or "what should I
see here?". The AI answers using:

- the venue's configured description, tone, and operator guidance,
- the venue's places (retrieved by **semantic search** over embeddings, or **geo-nearest** as a fallback),
- the guest's live GPS location (in `location_aware` mode).

Operators manage everything through a **dashboard**; the platform owner (Tom) has an **admin**
surface; **background workers** produce nightly analytics rollups and weekly AI-generated insight
digests.

### The three guide modes

A venue's `guideMode` column drives behavior end-to-end:

- `location_aware` (default) — uses GPS, talks about distances and what's nearby.
- `non_location` — a content/explainer guide (e.g. a museum audio-guide style); distances are suppressed.
- (the code also tolerates location-aware with a `defaultCenter` fallback when GPS is denied.)

---

## 2. Repository shape (monorepo)

pnpm workspaces + Turborepo. Two top-level groups: deployable `apps/*` and shared `packages/*`.

```
apps/
  web/         Next.js — public guest chat app (the visitor-facing product)
  dashboard/   Next.js — tenant operator console (also hosts the admin "Clients" page today)
  admin/       Next.js — platform-owner admin console (built, but NOT deployed yet)
  workers/     Node/BullMQ background worker process (no HTTP surface)

packages/
  db/          Prisma client, schema, migrations, tenant-isolation, audit, semantic search
  api/         tRPC v11 routers — ALL business logic lives here
  auth/        Clerk session resolution + role/permission helpers
  analytics/   emitEvent() + the registry of allowed analytics event types
  jobs/        BullMQ queue names, typed enqueue() helpers, Redis connection
  config/      env validation (zod), structured logger, feature-flag keys, shared eslint/tsconfig
  ui/          shared presentational components used by web + dashboard
```

### Dependency direction (enforced by convention / CLAUDE.md §4)

```
apps/*            → packages/api → packages/db, auth, analytics
apps/*            → packages/auth, ui
apps/workers      → packages/jobs, db, analytics, config
packages/*        → packages/config
```

- Only `packages/db` imports `@prisma/client`.
- Only `packages/auth` imports `@clerk/nextjs`.
- Only `packages/api` defines tRPC routers; apps just mount/call them.
- Only `apps/workers` imports `bullmq` for _running_ workers (jobs pkg wraps enqueuing).

### Build / tooling

- `package.json` scripts delegate to Turbo: `build`, `lint`, `typecheck`, `test` all `turbo run …`.
- TypeScript strict (with `exactOptionalPropertyTypes`, which is why you see the repeated
  `...(x !== undefined ? { x } : {})` spread pattern instead of passing `undefined`).
- Vitest for unit/integration tests, co-located `*.test.ts`.
- Husky + lint-staged + Prettier pre-commit; CI (`.github/workflows/ci.yml`) runs typecheck/lint/test.
- Package manager pinned to `pnpm@9.15.4`, Node ≥20.

---

## 3. The request/data flow at a glance

```
                         ┌─────────────────────────────────────────────┐
  Guest phone            │ apps/web  (public, unauthenticated)          │
  /{slug}/chat  ───────► │  React client → tRPC client → /api/trpc      │
                         └───────────────┬─────────────────────────────┘
                                         │
  Operator browser       ┌───────────────▼───────────┐
  dashboard      ───────►│ apps/dashboard (Clerk auth)│
                         └───────────────┬───────────┘
                                         │   all three apps mount the SAME router
  Platform owner         ┌───────────────▼───────────┐
  admin          ───────►│ apps/admin (PLATFORM_ADMIN)│
                         └───────────────┬───────────┘
                                         │
                         ┌───────────────▼──────────────────────────────┐
                         │ packages/api  (tRPC appRouter)                │
                         │  context → session resolve → procedure guards │
                         └───────────────┬──────────────────────────────┘
                                         │
              ┌──────────────────────────┼───────────────────────────────┐
              ▼                          ▼                               ▼
   packages/db (Prisma +      packages/analytics            external: Anthropic (chat),
   tenant isolation + audit)  emitEvent → analytics_events  OpenAI (embeddings), Redis (rate limit)
              │
              ▼
        PostgreSQL (Supabase) + pgvector

   apps/workers ── BullMQ (Redis) ── cron schedulers ── daily-rollup & weekly-digest processors
                  └─ write to daily_rollups / weekly_digests / job_records
```

---

## 4. The API layer (`packages/api`) — the heart of the system

All business logic is here. Apps only mount `appRouter` at `app/api/trpc/[trpc]/route.ts`.

### 4.1 tRPC wiring

- `core.ts` — `initTRPC` with superjson transformer; dev-only stack traces in error formatter.
- `context.ts` — `createTRPCContext({ req })` builds `{ db, headers, session }`. Calls
  `resolveSession(req)`; if there's no Clerk session it falls back to an **anonymous** session
  (`userId: null, activeTenantId: null`). This is what lets the public web app call `publicProcedure`s.
- `trpc.ts` — the four base procedures, composed from middleware:
  | Procedure | Composition | Use |
  |---|---|---|
  | `publicProcedure` | none | guest reads/writes (chat, public venue lookup, analytics ingest) |
  | `protectedProcedure` | `requireAuth` | authed but not yet tenant-scoped |
  | `tenantProcedure` | `requireAuth` + `requireTenant` | the default for operator actions |
  | `adminProcedure` | `requireAuth` + `requirePlatformAdmin` | platform-owner only |
- `root.ts` — assembles `appRouter` from the sub-routers and a public `health` query.

### 4.2 Middleware (`packages/api/src/middleware`)

- `require-auth` — throws `UNAUTHORIZED` if `session.userId` is null.
- `require-tenant` — throws `UNAUTHORIZED` if `activeTenantId` is null; narrows the session type.
- `require-platform-admin` — wraps `requirePlatformAdmin` from auth.
- `require-role(minRole)` — factory returning middleware that calls `requireTenantRole`; used as
  `.use(requireRole('MANAGER'))` on individual mutations. Role order is numeric `STAFF<MANAGER<OWNER`.

### 4.3 The routers

Mounted under these namespaces in `root.ts`:

- **`chat`** (`routers/chat.ts`) — _the product's core_. All `publicProcedure`. Three procedures:
  - `session` — idempotent visitor-session upsert (called when the chat page opens).
  - `send` — the main pipeline (detailed in §6).
  - `history` — loads prior messages for a returning visitor by `anonymousToken`.
- **`venue`** (`routers/venue.ts`) — `getBySlug` (public, for the guest app) + tenant CRUD,
  `getAiConfig`/`updateAiConfig` (AI persona, tone, featured place, guide name),
  `updateChatDesign` (theme/accent/logo/banner). Create needs `OWNER`, updates need `MANAGER`.
  Slugs are auto-generated and de-duplicated per tenant.
- **`place`** (`routers/place.ts`) — POI CRUD + `bulkCreate` (≤500). Every create/update enqueues
  an `embed-place` job to (re)generate the OpenAI embedding. `MANAGER`+.
- **`operationalUpdate`** (`routers/operational-update.ts`) — time-boxed notices (closures,
  warnings, redirects) attached to a venue/place. Writes audit logs. `MANAGER`+.
- **`analytics`** (`routers/analytics.ts`) — `trackEvent` (public, guest telemetry ingest +
  guest-session bookkeeping) and tenant-scoped read queries: `getDailyStats` (from `DailyRollup`),
  `getTopQuestions` (groups recent `message.sent` events), and weekly-digest getters.
- **`admin`** (`routers/admin/_admin.ts`) — `adminProcedure` only: `listClients`, `createClient`,
  `updateClientStatus`, `triggerDigest`. Uses `withTenantIsolationBypass` and `writeAuditLog`.

### 4.4 Input schemas

- Zod schemas live next to routers, or in `packages/api/src/schemas/*` when shared
  (`venue.ts`, `place.ts`, `operational-update.ts`) so the dashboard's react-hook-form can import
  the same schema it validates against. Strict objects (`.strict()`) are used widely.

### 4.5 Library helpers (`packages/api/src/lib`)

- `embeddings.ts` — compatibility exports for OpenAI `text-embedding-3-small` (1536 dims). Shared
  place embedding generation and text building live in `packages/db/src/helpers/embeddings.ts`;
  place writes enqueue background jobs instead of embedding inline.
- `geo.ts` — Haversine distance + `findNearestPlaces()` (the geo fallback ranker).
- `rate-limit.ts` — Redis (`ioredis`) fixed-window counter via `INCR`+`EXPIRE`. **Fails open**:
  if `REDIS_URL` is unset or Redis errors, requests are allowed.
- `venue-context.ts` — `buildVenueSystemPrompt()`, the big prompt builder (see §6).

---

## 5. The database layer (`packages/db`)

### 5.1 Client (`src/client.ts`)

- Single `PrismaClient` singleton (cached on `globalThis` in non-prod to survive HMR).
- Prisma v6 removed `$use` middleware, so tenant isolation is wired via a `$extends` query hook
  on `$allModels.$allOperations`. Raw operations (no `model`) pass straight through.
- `binaryTargets` include `linux-musl-openssl-3.0.x` for the Railway/Docker runtime.

### 5.2 Tenant isolation (`src/middleware/tenant-isolation.ts`) — the critical security control

- `TENANTED_TABLES` (in `tenanted-tables.ts`) lists every tenant-scoped model; `PLATFORM_TABLES`
  lists the global ones (`User`, `Tenant`, `AuditLog`, `PlatformConfig`).
- For a tenanted model, the middleware **throws `TenantIsolationError`** unless `tenant_id` is present:
  - `create`/`createMany` → must be in `data`,
  - `upsert` → must be in the `create` branch (the `where` uses a unique key, so it's exempt),
  - reads/updates/deletes → must be in `where`.
- **Bypass:** `withTenantIsolationBypass(fn)` uses `AsyncLocalStorage` to set a flag; only allowed
  in `admin.*` procedures and worker processors (which legitimately operate cross-tenant).
- Because raw SQL bypasses this hook entirely, every `$queryRaw` either binds `tenant_id` explicitly
  or is a deliberate public cross-tenant lookup (resolving a venue/session by slug/token), with a
  comment explaining why. This is the consistent pattern in `chat.ts`, `venue.getBySlug`, `analytics`.

### 5.3 Helpers (`src/helpers`)

- `audit.ts` — `writeAuditLog()`, the only sanctioned way to write the append-only `AuditLog`.
- `job-records.ts` — `writeJobRecord()` / `updateJobRecord()` for worker visibility.
- `membership-sync.ts` — `handleClerkEvent()` turns Clerk webhooks
  (`organization.created`, `organizationMembership.*`) into `Tenant`/`User`/`TenantMembership` rows,
  mapping Clerk org roles → tenant roles, soft-deleting on removal, writing audit logs.
- `semantic-search.ts` — `searchPlacesByEmbedding()` (raw pgvector `<=>` cosine query, manual
  `tenant_id` bind, annotates each row with Haversine distance) and `storePlaceEmbedding()`
  (raw `UPDATE … embedding = …::vector`). pgvector's `vector(1536)` type isn't expressible in
  Prisma's typed API, so raw SQL is required here.
- `feature-flags.ts` — per-tenant flag lookups (the `TenantFeatureFlag` table). Note the
  _flag-key registry_ in `config` is currently empty, so nothing is gated yet.

### 5.4 Schema & migrations (`prisma/`)

- `schema.prisma` defines both the **inherited platform tables** (`User`, `Tenant`,
  `TenantMembership`, `AuditLog`, `TenantFeatureFlag`, `PlatformConfig`) and the **actual product
  tables**:
  - `Venue` — name/slug/description, AI config (`aiGuideNotes`, `aiTone`, `aiGuideName`,
    `aiFeaturedPlaceId`), chat design (`chatTheme`/`chatAccentColor`/`chatLogoUrl`/`chatBannerUrl`),
    `guideMode`, `defaultCenter{Lat,Lng}`, `geoBoundary`.
  - `Place` — a POI: type/`itemType`, short/long descriptions, lat/lng (now optional),
    tags, `importanceScore`, `areaName`, hours, `photoUrl`, plus a raw `embedding vector(1536)`
    column added by migration (not in the Prisma model).
  - `VisitorSession` + `Message` — the guest chat conversation (keyed by `anonymousToken`).
  - `VisitorSession` — the single guest session model; analytics updates `lastActiveAt` and `messageCount`.
  - `AnalyticsEvent` — append-only business event log.
  - `DailyRollup` — pre-aggregated daily metrics (sessions/messages/place mentions).
  - `WeeklyDigest` — AI-generated weekly insight summaries.
  - `JobRecord` — every worker run, for admin visibility.
  - `OperationalUpdate`, `DataAdapter` (placeholder for future integrations).
- Migrations are forward-only and numbered/timestamped. `005_place_embeddings` enables the
  `vector` extension and creates an HNSW cosine index. Note the **mixed numbering scheme**:
  hand-named `001`–`009` plus later Prisma-timestamped migrations — they interleave chronologically.
- `DATABASE_URL` must be Supabase's **pooler** URL at runtime; `DIRECT_DATABASE_URL` (direct
  connection) is used only for migrations.

---

## 6. The chat pipeline (`chat.send`) — end to end

This is the single most important code path. When a guest sends a message:

1. **Resolve venue** by `venueId` via raw SQL (public cross-tenant lookup; pulls AI config + guide mode + default center).
2. **Mode/location guard** — in `location_aware` mode, require a usable lat/lng (guest GPS or venue default), else `BAD_REQUEST`.
3. **Rate limit** (two Redis windows, in parallel): per-session 60/hour and per-venue 30/min. Fails open if Redis is down.
4. **Upsert the `VisitorSession`** (by `anonymousToken`), updating last-known location.
5. **Embed the query + load history in parallel.** `generateEmbedding()` is wrapped in `.catch(() => null)` — a null embedding triggers the geo fallback. History = last 10 messages.
6. **Retrieve relevant places:**
   - embedding available → `searchPlacesByEmbedding()` (pgvector semantic search),
   - otherwise → `place.findMany` ordered by importance, then `findNearestPlaces()` (geo) in location mode.
7. **Resolve featured place** if the venue pinned one (`aiFeaturedPlaceId`).
8. **Build the system prompt** with `buildVenueSystemPrompt()` — injects venue identity, tone,
   operator guidance, the ranked place list (with natural-language distances), per-mode behavior
   rules, and a **language rule** (respect the guest's chosen language or auto-detect).
9. **Call Claude** — model `claude-haiku-4-5`, 512 max tokens, with the system prompt marked
   `cache_control: ephemeral` (prompt caching) and the message history. **Any failure returns a
   graceful canned message** rather than throwing.
10. **Persist** the user + assistant messages as _two separate writes_ (so they get distinct
    `createdAt` timestamps — a single transaction would tie them and make `orderBy desc` nondeterministic).
11. **Emit analytics** (`message.sent`, `message.received`) — best-effort, swallowed on error.
12. **Return** the response plus up to **3 places the AI actually named** in its reply (filtered by
    substring match + having coordinates), so the UI can render place cards. Suppressed entirely in
    `non_location` mode.

**Model usage summary:** Claude Haiku 4.5 for live guest chat (fast/cheap), Claude Sonnet 4.6 for
the weekly digest (deeper reasoning), OpenAI `text-embedding-3-small` for place embeddings.

---

## 7. Auth & multi-tenancy (`packages/auth`)

- `session.ts` — `resolveSession(req)` calls Clerk's `auth()`/`currentUser()`. It maps the Clerk
  **org** to `activeTenantId` (so the active tenant is always the JWT org claim, never client input),
  maps the Clerk org role to a `TenantRole`, and reads `platform_role === 'PLATFORM_ADMIN'` from
  public metadata. Wrapped in try/catch so guest apps without Clerk middleware get `null` → anonymous.
- `permissions.ts` — `requireTenantRole(ctx, minRole)` (numeric hierarchy) and
  `requirePlatformAdmin(ctx)`, both asserting types and throwing `FORBIDDEN`.
- Tenancy model: **Clerk Organization = Tenant**, `tenant_id` = Clerk org id. Memberships are
  mirrored into the DB via webhooks (see §5.3) for queryability. A user can belong to many tenants;
  the active one is whichever org the JWT carries.

### Per-surface auth posture

- **web** — `clerkMiddleware()` with no protected routes (guest app; needed only so `auth()` works).
- **dashboard** — `clerkMiddleware` redirects unauthenticated users to sign-in and users without an
  org to `/onboarding`; the Clerk webhook route is explicitly public (otherwise a 307 would break
  automatic tenant creation). The `(app)` layout re-checks `userId`/`orgId` server-side.
- **admin** — middleware hard-blocks anything without `platform_role === 'PLATFORM_ADMIN'` (403).

---

## 8. The apps

### 8.1 `apps/web` — the guest chat app (the real product)

- Routes: `/` (landing), `/{venueSlug}` (venue intro), `/{venueSlug}/chat` (the chat).
- The chat page (`app/[venueSlug]/chat/page.tsx`) is a client component orchestrating: venue load,
  history restore (via `sessionStorage` anonymous token), geolocation, session ensure, language
  selection, sending messages, and firing analytics events (`session.started/ended`,
  `place_card.viewed/clicked`, `directions.opened`).
- Hooks: `useGeolocation` (GPS + permission state), `useSession` (anonymous UUID token persistence).
- Components: `ChatWindow`, `MessageBubble`, `PlaceCard`, `QuickPromptChips`, `LocationBanner`,
  `LanguagePicker`, `TypingIndicator`. Brand palette is `pf-*` (Plus Jakarta Sans, light mode).
- PWA bits: `manifest.ts`, `public/sw.js`, `public/offline.html`, icons.
- Themed per venue at runtime via CSS variables (`--chat-accent`, `--chat-surface`) from
  `chatTheme`/`chatAccentColor`, optional logo/banner.

### 8.2 `apps/dashboard` — operator console (and current admin home)

- Auth-gated `(app)` group with sidebar nav (`DashboardShell`): Overview, Venues, Analytics,
  AI Controls, Chatbot Design, Operational Updates. (A `/clients` admin page also lives here today
  because `apps/admin` isn't deployed — see memory.)
- Venue + place CRUD pages, AI controls form, chat design form, operational updates, analytics page,
  onboarding flow. Forms use react-hook-form + the shared Zod schemas from `packages/api`.
- Hosts the **Clerk webhook** route (`/api/webhooks/clerk`) — verifies the Svix signature, then
  calls `handleClerkEvent`, always returning 200 to avoid Clerk retry storms.

### 8.3 `apps/admin` — platform-owner console (built, not deployed)

- Server components create a tRPC caller via `appRouter.createCaller(ctx)` and call `admin.*`.
  Pages: clients list, client detail, status form, trigger-digest button.
- Separate deployment intended (`admin.*` domain); for now operators-vs-owner separation is
  enforced by the `PLATFORM_ADMIN` checks, and Tom uses the dashboard's `/clients` page instead.

### 8.4 `apps/workers` — background jobs

- `src/index.ts` boots two BullMQ queues with **repeatable cron schedulers**:
  - `weekly-digest` — `0 23 * * 0` (Sun 23:00 UTC),
  - `daily-rollup` — `0 1 * * *` (01:00 UTC daily).
- It also runs the enqueue-driven `embed-place` queue, which has no cron scheduler.
- The scheduler jobs fan out one process job per **active tenant**; process jobs run with
  concurrency 2 and a 5-step retry backoff (30s→1m→5m→30m→2h, 6 attempts).
- Graceful `SIGINT`/`SIGTERM` shutdown drains workers and closes queues/Redis.
- Processors:
  - `daily-rollup.ts` — per venue, counts sessions/messages and **place mentions** (regex over the
    day's messages), wipes+rewrites that day's `DailyRollup` rows in a transaction.
  - `embed-place.ts` — loads a tenant-filtered place, generates an OpenAI embedding, stores it in
    pgvector, and writes a `JobRecord`.
  - `weekly-digest.ts` — gathers the week's sessions/messages, and if ≥5 sessions, prompts
    **Claude Sonnet 4.6** to return strict JSON insights (parsed/validated with Zod, with fenced-code
    and brace-extraction fallbacks), then writes them to `WeeklyDigest`. Under the threshold it
    completes with empty insights. Every run writes a `JobRecord`.

---

## 9. Analytics & jobs plumbing

- **`packages/analytics`** — `emitEvent()` writes one `AnalyticsEvent` row, internally try/caught so
  a failed analytics write never bubbles up. `events.ts` is the **typed allow-list** of event names
  (`session.started`, `message.sent`, `place_card.clicked`, …); the analytics router validates
  incoming events against it. Events are emitted **server-side only**.
- **`packages/jobs`** — `queues.ts` (queue/job-name constants), `connection.ts` (shared BullMQ
  Redis connection), `enqueue.ts` (typed `enqueueWeeklyDigest`, `enqueueDailyRollup`, and
  `enqueueEmbedPlace` with deterministic `jobId`s for idempotency), `types.ts` (payload types).
  Apps/routers enqueue through these; only the worker process constructs `Worker`s.
- **Two-tier analytics, as designed:** raw `AnalyticsEvent` (recent/append-only) → nightly
  `DailyRollup` (fast dashboard reads). Dashboard aggregate reads hit rollups/events, never OLTP
  tables. PostHog (product analytics) is referenced in env but not wired in code.

---

## 10. Cross-cutting conventions worth knowing

- **`exactOptionalPropertyTypes` spread pattern** — `...(v !== undefined ? { k: v } : {})` appears
  everywhere because Prisma's typed API rejects explicit `undefined` under this TS setting.
- **`updateMany`/`deleteMany` instead of `update`/`delete`** — used so `tenant_id` can be included
  in `where` (single-row `update`/`delete` require a unique key and won't accept the extra filter),
  satisfying the isolation middleware. Followed by a `findFirst` to return the row.
- **Fail-open vs fail-closed** — rate limiting, embeddings, analytics, and the Claude call all
  **fail open / degrade gracefully** (guests are never hard-blocked by infra). Auth, tenant
  isolation, and role checks **fail closed** (throw).
- **Raw SQL is the deliberate exception** — only for public cross-tenant lookups and pgvector;
  always commented, always either tenant-bound or justified.
- **Structured logging** — `packages/config/logger.ts` writes single-line JSON to stdout with
  `timestamp/level/service/action`; IDs only, no PII.
- **Append-only tables** — `AuditLog` and `AnalyticsEvent` are never updated/deleted.

---

## 11. Deployment & environments (from memory + config)

- Hosted on **Railway**; **Supabase** Postgres (pooler URL at runtime, direct URL for migrations);
  **Redis** on Railway for BullMQ + rate limiting.
- Services: dashboard, web (guest app), workers (no public URL), Redis. `apps/admin` not yet deployed.
- Key env vars (validated by `packages/config/src/env.ts`): `DATABASE_URL`, `DIRECT_DATABASE_URL`,
  Clerk keys + `CLERK_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `REDIS_URL`. Several
  others (storage, Resend, PostHog, integration encryption) are declared but unused/optional.
- `env.ts` skips strict validation during Next.js production builds (vars injected at runtime).

---

## 12. Gap analysis — architecture intent vs. shipped code

| Designed in `architecture.md` / `CLAUDE.md`                                   | Reality in code                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Listings, Events, Bookings, GuestUser, AvailabilitySlot                       | **Not built.** Replaced by Venue / Place / VisitorSession / Message                                                      |
| Integration framework (adapters, registry, sync logs, webhook events, crypto) | **Not built** — the empty `packages/integrations` package was removed; `DataAdapter` remains an unused placeholder table |
| `packages/ui` shared components                                               | Shared presentational components now live here for web + dashboard                                                       |
| Feature flags for plan gating                                                 | Table + helpers exist, but the **key registry is empty** — nothing is gated                                              |
| S3/R2 file uploads, presigned URLs                                            | Not implemented; venues use external image URLs (`chatLogoUrl`, `photoUrl`)                                              |
| Email/notification dispatch, token refresh, booking-expiry jobs               | Not implemented; only daily-rollup + weekly-digest jobs exist                                                            |
| PostHog product analytics                                                     | Env var only; not wired                                                                                                  |
| Admin impersonation sessions                                                  | `AdminImpersonationSession` not in the current schema; not built                                                         |
| Separate admin deployment                                                     | Built but **not deployed**; admin lives in the dashboard for now                                                         |
| The AI venue-guide chatbot itself                                             | **The actual product** — not mentioned in the original architecture doc at all                                           |

**Net:** the codebase faithfully kept the platform _foundations_ the architecture mandated
(tenant isolation middleware, audit logging, analytics event log + rollups, role hierarchy, Clerk
org=tenant, job records, structured logging) and built a **focused AI-guide product** on top,
while leaving the heavier generic-SaaS subsystems (integrations, bookings, billing, file storage)
as unbuilt scaffolding. When extending it, follow `CLAUDE.md` for the rules that still apply
(isolation, audit, server-side analytics, routers-in-`packages/api`) and ignore the parts of the
architecture doc that describe subsystems that were never built.

```

---

## 13. Quick "where do I change X?" index

| I want to… | Go to |
|---|---|
| Change how the AI answers | `packages/api/src/lib/venue-context.ts` (prompt) + `routers/chat.ts` (pipeline) |
| Add a place field | `prisma/schema.prisma` → migration → `schemas/place.ts` → `routers/place.ts` → `embeddings.ts` text builder → dashboard `PlaceForm` |
| Add an analytics event | `packages/analytics/src/events.ts` (allow-list) then emit server-side |
| Add a tenant-scoped table | schema + migration + add to `tenanted-tables.ts` |
| Add a background job | `packages/jobs` (queue + enqueue + type) → `apps/workers` processor; add a scheduler only for cron jobs |
| Add an operator screen | `packages/api` router/procedure → `apps/dashboard` page/component |
| Change guest chat UI/theme | `apps/web/components/*` + venue `chatTheme`/`chatAccentColor` |
| Adjust auth/roles | `packages/auth` (session + permissions) + `require-*` middleware |
```
