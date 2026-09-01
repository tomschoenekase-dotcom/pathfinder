# PathFinder — Architecture Snapshot (as of 2026-08-05)

> **Migration instruction status: HISTORICAL — DO NOT EXECUTE.**

> **Current-truth status: HISTORICAL SNAPSHOT.** This file no longer supersedes the maintained
> sources under `docs/system-state/`. Use `torchiko-current-truth.json`,
> `TORCHIKO_CAPABILITY_MATRIX.md`, and `TORCHIKO_AUDIT_BACKLOG.md` for current release decisions.

> Read-only analysis for planning a one-month scaling effort. No code was changed to produce this
> document. Every claim below is either **Confirmed** (I read the exact file/line) or **Inferred**
> (reasonable conclusion without direct evidence) — inferred claims are labeled explicitly.
> `docs/architecture.md` is historical design intent for a much broader SaaS platform and diverges
> significantly from the shipped product; where the two disagree, this document follows the real code.
> `docs/codebase-overview.md` (generated earlier, 2026-07-02-ish) is a good companion but is missing
> several tables/features added since (knowledge base, engagement questions, weekly reports, answer
> analysis, media ingestion lab) — at the time, this document superseded that older overview only.

---

## 1. Executive overview

**What PathFinder does.** PathFinder is a B2B SaaS product: venue operators (museums, parks,
attractions) configure a venue and its points of interest, and their visitors get a mobile,
AI-powered chat guide at `/{venueSlug}/chat`. The guest optionally shares GPS location; the AI
answers using the venue's configured tone/instructions, semantically-retrieved places and
knowledge-base entries, active operational alerts, and (in `location_aware` mode) live distance
context. Operators manage content and see analytics in a dashboard; a platform owner manages all
tenants from an admin surface embedded in that same dashboard app.

**Main user types:**

- **Guests** — anonymous, unauthenticated visitors using the public chat (`apps/web`).
- **Operators** (`STAFF < MANAGER < OWNER`) — venue staff managing content via `apps/dashboard`.
- **Platform admin** — Tom, gated by Clerk `publicMetadata.platform_role === 'PLATFORM_ADMIN'`,
  using the `(admin)` route group inside `apps/dashboard` (there is **no separate `apps/admin`
  app** — it existed historically per `CLAUDE.md`/older docs but has been deleted from the repo;
  Confirmed via directory search — see §2).

**Major product surfaces:**

1. `apps/web` — public guest chat PWA (also a thin marketing landing page).
2. `apps/dashboard` — operator console (`(app)` route group) **and** platform-admin console
   (`(admin)` route group), in one Next.js app, gated by role at the layout and tRPC-procedure
   level (not by separate deployment).
3. `apps/workers` — BullMQ background worker process, no public HTTP surface.
4. `packages/api` — the single tRPC router all three apps mount; all business logic lives here.

**How a visitor question travels through the system** (Confirmed, `packages/api/src/routers/chat.ts`):
guest types a message → `chat.send` tRPC mutation (public, unauthenticated) → resolve venue by ID
via a commented public cross-tenant raw-SQL lookup → rate-limit check (Redis, fail-open) → upsert
`VisitorSession` → in parallel: embed the query (OpenAI), load last 10 messages, load active
`OperationalUpdate`s, load tenant `engagementMode`, load engagement questions → semantic search
(pgvector) for places + knowledge entries, or geo/importance fallback if embedding failed → build a
two-part (cached/uncached) system prompt → call Claude Haiku (non-streaming, 512 max tokens) → strip
an internal engagement marker, hard-truncate to 60 words → persist user+assistant messages → emit
analytics events (best-effort) → return response + up to 3 mentioned places for map/photo cards.

**How venue data is created, stored, retrieved, and used:** operators create `Venue`/`Place`/
`VenueKnowledgeEntry` rows through tenant-scoped tRPC procedures in the dashboard (or a JSON bulk
importer); place/knowledge writes enqueue a background OpenAI-embedding job so the admin-facing save
is fast; those embeddings live in a raw pgvector column (`embedding vector(1536)`, not represented in
the Prisma schema) and are queried via a raw cosine-similarity SQL search at chat time.

**Deployment (Confirmed):** Railway hosts three services — `dashboard` (Nixpacks build), `web` and
`workers` (Dockerfile builds) — plus Railway-hosted Redis. Postgres is Supabase (pooled URL at
runtime, direct URL for migrations, applied **manually**, not via CI/CD — see §7). No staging
environment exists.

**Production-readiness assessment (my synthesis):**

- **Production-ready:** tenant isolation middleware, auth/role model, core chat pipeline
  (fail-open design), audit logging, rate limiting, CI (typecheck/lint/test on every push).
- **Working but has real gaps:** canonical AI usage/cost events exist, but live provider-quality and
  representative cost observations remain gated; project-local media cent fields are legacy display
  scaffolding. In-memory rate-limit fallback still isn't multi-instance-safe.
- **Experimental / recently added, less proven:** engagement questions "curious mode" (AI-invented
  questions), nightly analytics-enrichment (topic classification, weekly themes, question
  clustering), weekly reports and answer-analysis (Sonnet-generated, Zod-validated with
  truncate-before-validate fallbacks).
- **2026-09-01 correction:** the media-ingestion lab defaults to the reviewed public API model
  `gpt-5.6-luna` for image analysis and synthesis and to `gpt-4o-mini-transcribe` for transcription.
  OpenAI's current model contract documents Luna for Chat Completions, structured outputs, and image
  input, and lists the stable alias as its only snapshot identifier. Unreviewed environment overrides
  fail before archive processing or provider dispatch.
- **Built but not load-bearing:** `DataAdapter` table (integration placeholder, unused), feature-flag
  key registry (table + helpers exist, empty registry — nothing gated), PostHog (env var declared,
  no SDK wired).

---

## 2. Repository structure

Monorepo: pnpm workspaces + Turborepo, Node ≥20, pnpm 9.15.4 pinned (`package.json`).

```
apps/
  web/         Next.js 15 — public guest chat PWA (the actual product surface guests touch)
  dashboard/   Next.js 15 — operator console AND platform-admin console (merged into one app)
  workers/     Node + BullMQ — background jobs, no HTTP server, built with tsup
  (admin/      historically existed as a separate app; CONFIRMED REMOVED from the repo —
               CLAUDE.md and older docs still describe it as a separate deployment target)

packages/
  db/          Prisma client + schema + migrations, tenant-isolation middleware, audit,
               semantic search (pgvector raw SQL), embeddings helpers, job-record helpers
  api/         tRPC v11 — every router, every schema, every piece of business logic
  auth/        Clerk session resolution, role/permission helpers, org creation
  analytics/   emitEvent() + the AnalyticsEventType allow-list
  jobs/        BullMQ queue/job-name constants, typed enqueue() helpers, Redis connection
  config/      Zod-validated env, structured logger, feature-flag keys, shared eslint/tsconfig
  ui/          shared presentational components (theming math, brand, FadeIn) — no data/auth
```

Enforced dependency direction (per `CLAUDE.md`, spot-checked by the frontend/security agents —
Confirmed no violations found): `apps/* → packages/api → packages/db|auth|analytics`; only
`packages/db` imports `@prisma/client`; only `packages/auth` imports Clerk server SDKs; only
`packages/api` defines tRPC routers; only `apps/workers` runs BullMQ `Worker`s (other code enqueues
through `packages/jobs`).

### Per-component read

| Component                           | Purpose                                                        | Entry point                                       | Used by                                     | Status                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/db`                       | Prisma schema/client, tenant isolation, audit, semantic search | `src/client.ts`, `src/index.ts`                   | `packages/api`, `apps/workers`              | Active, core                                                                                                         |
| `packages/api`                      | All tRPC routers/business logic                                | `src/root.ts` → `_app.ts` (assembles `appRouter`) | all 3 apps                                  | Active, core                                                                                                         |
| `packages/auth`                     | Session/role resolution from Clerk                             | `src/session.ts`, `permissions.ts`                | `packages/api`, `apps/dashboard` middleware | Active, core                                                                                                         |
| `packages/analytics`                | `emitEvent()` + allow-list                                     | `src/emit-event.ts`, `events.ts`                  | `packages/api` routers, `apps/workers`      | Active                                                                                                               |
| `packages/jobs`                     | Queue/job constants, enqueue helpers, Redis connection         | `src/enqueue.ts`, `queues.ts`                     | `packages/api`, `apps/workers`              | Active, growing (9 queues)                                                                                           |
| `packages/config`                   | Env validation, logger, feature flags                          | `src/env.ts`, `logger.ts`                         | everywhere                                  | Active                                                                                                               |
| `packages/ui`                       | Presentational components + theme math                         | `src/index.ts`                                    | `apps/web`, `apps/dashboard`                | Active, small, clean (Confirmed no data/auth logic — grep returned zero hits)                                        |
| `apps/web`                          | Guest chat PWA                                                 | `app/[venueSlug]/chat/page.tsx`                   | guests                                      | Active, the real product                                                                                             |
| `apps/dashboard`                    | Operator console + platform-admin console                      | `app/(app)/*`, `app/(admin)/*`                    | operators, platform admin                   | Active                                                                                                               |
| `apps/workers`                      | Background jobs (9 BullMQ queues)                              | `src/index.ts` (`startWorkers()`)                 | scheduled crons + enqueue-driven jobs       | Active                                                                                                               |
| `DataAdapter` model                 | Integration placeholder                                        | `prisma/schema.prisma`                            | nothing reads/writes it besides scaffolding | **Unused placeholder** (Confirmed by `docs/codebase-overview.md` gap analysis; not contradicted by any new evidence) |
| Feature flags (`TenantFeatureFlag`) | Per-tenant gating                                              | `packages/db/src/helpers/feature-flags.ts`        | nothing — key registry is empty             | **Built, not exercised**                                                                                             |

---

## 3. Frontend architecture

**Framework:** Next.js 15 (App Router) in both `apps/web` and `apps/dashboard`, both built with
`output: 'standalone'` (Confirmed, `next.config.ts` in each app). React function components, no
Redux/Zustand/Jotai/Context store anywhere — state is local `useState`/`useRef`/`useEffect`
(Confirmed by frontend audit).

### apps/web — guest chat PWA

- Routes: `/` (marketing landing), `/{venueSlug}` (server-rendered venue intro, calls
  `appRouter.createCaller` directly — no HTTP hop), `/{venueSlug}/chat` (the product).
- **State management:** no global store; the chat page (`app/[venueSlug]/chat/page.tsx`) is one
  large client component owning `messages`, geolocation, session bootstrap, language selection, and
  analytics side effects, each as its own `useEffect`.
- **API calls:** a **vanilla (non-React-Query) tRPC client** built via `createTRPCClient()`,
  invoked imperatively (`.query()`/`.mutate()`) inside effects/handlers — not `trpc.useQuery` hooks.
- **Streaming: none.** `chat.send` is `await`ed in full; the assistant message is appended to state
  only after the whole tRPC response resolves. The Anthropic call itself is also non-streaming
  (`anthropic.messages.create` without `stream: true`). No SSE/websocket anywhere in the chat path.
- **Styling/theme:** Tailwind + a `pf-*` brand palette (Plus Jakarta Sans + 5 other Google fonts
  loaded as CSS vars for per-venue `chatFont`). Per-venue runtime theming resolved by
  `getChatPalette()`/`deriveNeonPalette()` in `packages/ui/src/theme.ts` (5 named presets +
  computed dark/"neon" mode + optional hex accent override), injected as CSS custom properties in
  an inline `<style>` block. Logo/banner applied as direct `<img>`/`background-image`.
  Mobile-responsive: `min-h-dvh`/`h-svh`, `env(safe-area-inset-*)`, `sm:`/`lg:` breakpoints, 44px+
  tap targets.
- **PWA:** `app/manifest.ts` (Next-generated) **and** a second static `public/manifest.webmanifest`
  that `app/layout.tsx` links to explicitly — a minor duplicate-source drift risk. `public/sw.js` is
  minimal (caches `/` + `offline.html`, network-first otherwise, no asset caching strategy).
- **Error/loading states:** `isBooting` (full-page spinner), `pageError` (venue-not-found card),
  `isSending` (typing indicator), `sendError` (inline banner). No React error boundary.
- **Component sizing:** all small/focused; largest is `QuickPromptChips.tsx` (267 lines — mixes a
  fair amount of embedded localization copy tables with UI, worth splitting eventually, not urgent).

### apps/dashboard — operator console + platform-admin console (merged)

- Route groups: `(auth)` (Clerk sign-in/up), `(app)` (operator console — venues, places,
  analytics, weekly reports, AI controls, engagement questions, chat design, operational updates,
  settings, onboarding), `(admin)` (platform-admin — client list/create, per-tenant/venue
  drill-downs: analytics, chatlogs, media ingestion lab, weekly reports).
- **Operator and platform-admin UI are not cleanly separated** — they're one Next app sharing
  session/cookie mechanics. A platform admin sees an "Admin" link injected into the tenant sidebar;
  admins can **impersonate** a tenant ("View as client" → sets an `httpOnly`/`secure`
  `pf_admin_tenant` cookie) and the _same_ operator `(app)` UI renders with an amber "Admin view:
  {orgName}" banner. Authorization is layered three times for the same gate: middleware
  (redirect-only), `(admin)/layout.tsx` (Clerk metadata check, explicitly documented as UX-only),
  and `adminProcedure` on the tRPC router (the real boundary).
- **API calls:** mixes `createTRPCReact` (React-Query hooks) for some flows and a vanilla
  `createTRPCClient()` (instantiated per-component, no shared instance/hook) for most
  forms/admin components — an inconsistency worth normalizing.
- **Styling:** same Tailwind/`pf-*` system as web; `ChatDesignForm.tsx` is the operator-facing
  editor for the same `packages/ui` theme presets consumed at runtime by `apps/web`.
- **Largest/most crowded components** (all in `apps/dashboard/components`, all combining
  react-hook-form + Zod validation + an inline tRPC client + view logic in one file):

  | File                                | Lines | Note                                                                |
  | ----------------------------------- | ----- | ------------------------------------------------------------------- |
  | `PlaceForm.tsx`                     | 713   | Largest file in the whole codebase — flag as overly coupled/crowded |
  | `EngagementQuestionsManager.tsx`    | 532   | Full CRUD list+form in one file                                     |
  | `VenueForm.tsx`                     | 422   |                                                                     |
  | `KnowledgeManager.tsx`              | 360   |                                                                     |
  | `VenueJsonImporter.tsx`             | 355   |                                                                     |
  | `admin/MediaIngestionWorkbench.tsx` | 354   |                                                                     |
  | `OperationalUpdateForm.tsx`         | 302   |                                                                     |
  | `OperationalUpdatesList.tsx`        | 279   |                                                                     |
  | `AiControlsForm.tsx`                | 277   |                                                                     |

  This is a recurring "one big client component per feature" pattern (form + validation + data
  access + view all in one file) rather than a layered structure. Worth addressing before adding
  more operator-facing screens for scale.

### Authentication flow (both apps)

Clerk-based. `apps/web` uses `clerkMiddleware()` with no protected routes (only present so
`auth()` resolves; guests remain anonymous). `apps/dashboard/middleware.ts` requires
`authState.userId`, redirects org-less users to `/onboarding` (except `/admin*` paths), and computes
an `effectiveOrgId` that falls back to the impersonation cookie only for confirmed platform admins.
The Clerk webhook route (`/api/webhooks/clerk`) is the one deliberately public dashboard route,
verifying Svix signatures before calling `handleClerkEvent()`.

---

## 4. Backend architecture

**Framework/runtime:** Next.js Route Handlers mount a single tRPC v11 `appRouter`
(`packages/api/src/root.ts`) at `app/api/trpc/[trpc]/route.ts` in both `apps/web` and
`apps/dashboard`. `apps/workers` is a plain Node process (built with `tsup`, run via
`node dist/index.js`) with no HTTP server at all.

### Procedures (`packages/api/src/trpc.ts`)

| Procedure            | Middleware chain                       | Use                                               |
| -------------------- | -------------------------------------- | ------------------------------------------------- |
| `publicProcedure`    | none                                   | guest chat, public venue lookup, analytics ingest |
| `protectedProcedure` | `requireAuth`                          | authed, not tenant-scoped                         |
| `tenantProcedure`    | `requireAuth` + `requireTenant`        | default operator action                           |
| `adminProcedure`     | `requireAuth` + `requirePlatformAdmin` | platform-owner only                               |

Individual mutations further layer `.use(requireRole('MANAGER'))` for content-mutating operator
actions.

### Routers (mounted in `root.ts`)

- **`chat`** — `session`, `send`, `history` — the core product path (detailed request-flow below).
- **`venue`** — public `getBySlug` + tenant CRUD, AI-config, chat-design.
- **`place`** — CRUD + `bulkCreate` (≤500), enqueues `embed-place` on every write.
- **`knowledge`** — CRUD + `bulkCreate` (≤500) for `VenueKnowledgeEntry`, enqueues
  `embed-knowledge-entry`.
- **`operationalUpdate`** — time-boxed closures/alerts, audit-logged.
- **`engagementQuestion`** — CRUD for authored engagement questions (curious-mode feature).
- **`analytics`** — public `trackEvent` ingest + tenant-scoped read queries.
- **`tenant`** — tenant-level settings (not deep-dived in this pass; small router, 109 lines).
- **`admin/_admin`** — platform-admin only: client CRUD, plan/status, chatlog review/notes,
  answer-analysis + weekly-report + digest generation/publishing, all under
  `withTenantIsolationBypass` (1099 lines — the single largest router).
- **`admin/media-ingestion`** — S3 multipart upload orchestration + project CRUD for the media
  ingestion lab (no AI calls itself; enqueues the worker job).

### Auth & tenant identification

`activeTenantId` always comes from the Clerk org claim in the JWT (`packages/auth/src/session.ts`),
**never from client input** — Confirmed no code path lets a request body/header set tenant or role.
Platform-admin status is `publicMetadata.platform_role === 'PLATFORM_ADMIN'`, also server-resolved
only. The one exception, the `pf_admin_tenant` impersonation cookie, is itself only honored after a
server-side `isPlatformAdmin` check (§8).

### Background processing

9 BullMQ queues, all defined in `packages/jobs/src/queues.ts`, all workers started in
`apps/workers/src/index.ts::startWorkers()`:

| Queue                   | Trigger                                                       | Concurrency                                                                    | Retry                      |
| ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| `weekly-digest`         | cron `0 23 * * 0` (Sun 23:00 UTC), fans out per active tenant | 2                                                                              | 6 attempts, 30s→2h backoff |
| `daily-rollup`          | cron `0 1 * * *`                                              | 2                                                                              | 6 attempts                 |
| `analytics-enrichment`  | cron `30 1 * * *` (after daily-rollup)                        | 2                                                                              | 6 attempts                 |
| `embed-place`           | enqueued on every place create/update                         | 2                                                                              | 6 attempts                 |
| `embed-knowledge-entry` | enqueued on every knowledge-entry create/update               | 2                                                                              | 6 attempts                 |
| `answer-analysis`       | enqueued by admin `generateAnswerAnalysis`                    | 2                                                                              | 6 attempts                 |
| `weekly-report`         | enqueued by admin `generateWeeklyReportDraft`                 | 2                                                                              | 6 attempts                 |
| `send-email` (welcome)  | enqueued on tenant/client creation                            | 4                                                                              | 3 attempts                 |
| `media-ingestion`       | enqueued by admin media-ingestion upload flow                 | **1** (deliberately serialized — can hold GBs of temp data + many model calls) | 3 attempts                 |

All processors write/update a `JobRecord` (queue, jobName, status, tenantId, payload, error,
timestamps) for admin visibility. Graceful `SIGINT`/`SIGTERM` shutdown drains all workers/queues.

### AI orchestration

See §6 for the full inventory. In short: guest chat calls Claude Haiku synchronously; five
background jobs call Claude Sonnet or Haiku (weekly digest, weekly report, answer analysis, nightly
topic classification, nightly weekly-theme synthesis); the media-ingestion lab calls OpenAI vision +
transcription models; embeddings (OpenAI `text-embedding-3-small`) back semantic search for both
places and knowledge entries.

### Error handling / logging

Procedures throw `TRPCError`, never ad hoc objects (Confirmed pattern throughout the routers read).
Structured JSON logging via `packages/config/src/logger.ts` (timestamp/level/service/action, IDs
only — no PII/secrets by convention). External-service failures (Claude, OpenAI, Redis) are
deliberately **fail-open** for the guest-facing path; auth/tenant/role checks are **fail-closed**.

### File uploads

Only the media-ingestion lab (admin-only) uploads files — via presigned S3-multipart URLs
(1-hour expiry), tenant/venue/project-scoped object keys, sanitized filenames. No general-purpose
file upload exists elsewhere in the product (venue logos/photos are external URLs, not uploads).

### Email / notifications

One transactional email exists: a welcome email via Resend, sent through the `send-email` BullMQ
queue (`apps/workers/src/processors/send-welcome-email.ts`) when a new tenant/client is created.
No other notification system.

### Payments

**Not found.** `Tenant.planTier` (free/pro/enterprise) and `Tenant.nextPaymentDue` exist as fields,
editable by a platform admin (`setTenantPaymentDue`, `updateClientPlanTier`), but there is no
payment provider integration, webhook, or billing logic anywhere in the code — this is a manual,
admin-tracked field, not automated billing.

### Request-flow diagram (guest chat — the core path)

```
Guest phone
  │  POST /api/trpc/chat.send  (apps/web, publicProcedure)
  ▼
packages/api/src/routers/chat.ts
  │
  ├─ 1. Resolve venue by id  ── raw SQL, public cross-tenant lookup (commented, justified)
  ├─ 2. Guard guideMode/location (400 if location_aware with no coords)
  ├─ 3. Rate limit (Redis fixed-window, fail-open)         ─┐
  ├─ 4. Upsert VisitorSession                                │ parallel where possible
  ├─ 5. Promise.all: embed query (OpenAI, catch→null),        │
  │      load history(10), load active OperationalUpdates,    │
  │      load tenant.engagementMode, load EngagementQuestions │
  ├─ 6. Retrieve:                                             │
  │      embedding ok  → pgvector cosine search (places + knowledge, parallel)
  │      embedding null→ importance-ordered fallback + haversine geo ranking
  ├─ 7. Resolve featured place (if aiFeaturedPlaceId set)
  ├─ 8. Build system prompt (static cached block + dynamic block)
  ├─ 9. Call Claude Haiku (claude-haiku-4-5-20251001, 512 max tokens, non-streaming)
  │      on any error → canned apology string, never throws
  ├─ 10. Strip engagement marker, enforce 60-word cap
  ├─ 11. Persist user + assistant Message rows (two writes, distinct timestamps)
  ├─ 12. Update/clear pending-engagement-question session state
  ├─ 13. emitEvent(message.sent / message.received / engagement_question.asked / message.low_confidence) — all best-effort
  └─ 14. Return { response, sessionId, places[≤3 mentioned] }
  ▼
PostgreSQL (Supabase, pgvector)   +   Redis (rate limit)   +   Anthropic API   +   OpenAI API
```

---

## 5. Data architecture

**Provider:** PostgreSQL via Supabase, accessed exclusively through Prisma (no Supabase SDK usage —
Confirmed by grep; Supabase is purely the Postgres host). `pgvector` extension enabled via migration
`005_place_embeddings`.

### Major tables (Confirmed from `packages/db/prisma/schema.prisma`)

**Platform (not tenant-scoped):** `User`, `Tenant`, `AuditLog`, `PlatformConfig`.

**Tenanted (21 models, must include `tenant_id`, enumerated in
`packages/db/src/tenanted-tables.ts`):** `TenantMembership`, `TenantFeatureFlag`, `Venue`, `Place`,
`VenueKnowledgeEntry`, `VisitorSession`, `Message`, `DataAdapter`, `OperationalUpdate`,
`AnalyticsEvent`, `DailyRollup`, `QuestionCluster`, `EngagementQuestion`,
`EngagementQuestionResponse`, `AdminChatlogNote`, `WeeklyReport`, `AnswerAnalysisSnapshot`,
`VenueWeeklyTheme`, `WeeklyDigest`, `MediaIngestionProject`, `MediaIngestionAsset`.

**Note — a real discrepancy:** `CLAUDE.md`'s tenanted-table list (in this repo's own constitution
document) only names 10 of these 21 tables — it has not been updated as the product grew
(engagement questions, knowledge base, weekly reports, answer analysis, media ingestion, question
clusters, admin chatlog notes are all missing from `CLAUDE.md`'s list even though the actual
`tenanted-tables.ts` correctly includes them). This is a documentation-drift finding, not a security
gap — the code's own source of truth is `tenanted-tables.ts` and it is complete/correct.

### Key relationships (plain-English)

- `Tenant` 1—N `Venue` 1—N `Place` / `VenueKnowledgeEntry` / `OperationalUpdate`.
- `Venue` 1—N `VisitorSession` 1—N `Message`; a session can have N `EngagementQuestionResponse`
  (each optionally tied to an authored `EngagementQuestion`, nullable when AI-invented) and N
  `AdminChatlogNote` (admin-authored annotations).
- `Tenant` 1—N `TenantMembership` N—1 `User` (Clerk org membership mirror), 1—N
  `WeeklyDigest`/`WeeklyReport`/`AnswerAnalysisSnapshot`/`VenueWeeklyTheme`/`QuestionCluster`
  (all AI/analytics outputs, scoped to tenant, most also to venue).
- `MediaIngestionProject` 1—N `MediaIngestionAsset`, scoped to tenant+venue; raw media lives in
  object storage, the DB only holds orchestration state/evidence/questions/drafts (explicit
  design comment in the schema).
- There is **no** "exhibit" or "guide item" model distinct from `Place` — the architecture doc's
  vocabulary (listings/exhibits/guide items) does not exist in the shipped schema; `Place` +
  `VenueKnowledgeEntry` cover that role.

### Tenant separation enforcement

**Enforced primarily in backend code**, specifically a single, well-tested chokepoint:
`packages/db/src/middleware/tenant-isolation.ts`, wired as a Prisma `$extends` query hook (Prisma
v6 removed `$use` middleware). It throws `TenantIsolationError` on any typed Prisma call against a
tenanted model that omits `tenant_id` from `data` (create) or `where` (read/update/delete). This is
**not** database-level (no Postgres RLS policies found — Confirmed by absence in migrations) and
**not** frontend-enforced (frontend role checks are explicitly documented as cosmetic in
`CLAUDE.md` and confirmed as such by the security audit). So: **backend-code enforcement**, via one
central, unit-tested middleware, is the actual control — this is a reasonable, if unusual (no DB-native
defense-in-depth via RLS), design for this codebase's current scale.

Bypass (`withTenantIsolationBypass`, `AsyncLocalStorage`-based) is exercised only inside
`adminProcedure`-gated handlers (Confirmed: every call site checked is inside `admin/_admin.ts` or
`admin/media-ingestion.ts`) and inside worker processors that explicitly filter by tenant.

Raw SQL (`$queryRaw`/`$executeRaw`) bypasses the middleware entirely by construction. Every instance
found (session/send/history venue lookups in `chat.ts`, `venue.getBySlug`, `analytics`'s
`resolveVenueTenant`, pgvector search/store in `semantic-search.ts`) either binds `tenant_id`
explicitly as a query parameter or is a commented, deliberate public lookup resolving tenant
identity _from_ an unguessable public key (venue id/slug, UUID session token) before any
tenant-scoped Prisma call runs. All use tagged-template parameter binding — no string concatenation
found anywhere (i.e., no raw SQL injection surface).

**Where one client could theoretically touch another's data — assessed and found not exploitable
today:**

- `storePlaceEmbedding`/`storeKnowledgeEntryEmbedding` update by primary key with no `tenant_id` in
  their `WHERE` clause, but every caller passes an `id` obtained from a prior tenant-scoped query —
  not attacker-controlled. **No live vulnerability**, but worth tightening (add `tenant_id` to the
  `WHERE` anyway) as defense-in-depth before scaling admin/API surface.
- No other missing-tenant-scope pattern was found across either the security or data-architecture
  passes.

### Storage buckets / uploaded assets

S3-compatible object storage (bucket/region/endpoint/credentials are env-configured,
provider-agnostic) is used **only** by the media-ingestion lab, admin-only, tenant/venue/project
namespaced object keys, presigned multipart upload URLs. Everywhere else in the product (venue
logos, banners, place photos), assets are **external URLs** the operator pastes in — there is no
general file-upload/storage feature for operator content.

### Embeddings / vector search

`vector(1536)` columns on `places` and `venue_knowledge_entries`, added by raw SQL migration (not
representable in the Prisma schema — Prisma has no native pgvector type), HNSW cosine index. Query
via raw SQL cosine-distance operator `<=>`, tenant_id bound explicitly, distance clamped to sane
limits. Embedding model: OpenAI `text-embedding-3-small`, 1536 dims, used identically for chat-time
retrieval, place/knowledge indexing jobs, and nightly question clustering.

### JSON import structure

`VenueJsonImporter.tsx` (dashboard) bulk-imports places and knowledge entries via the `bulkCreate`
tRPC mutations (≤500 rows each, `$transaction`-wrapped). Not deep-dived at the schema level in this
pass — flag as a file worth reading directly if planning to extend import formats (see §14).

### Backups / version history / audit logging

- **Audit:** `AuditLog` (append-only, `writeAuditLog()` helper) covers admin mutations (client
  create/status/plan, chatlog notable/notes, report generate/edit/publish, digest trigger) and key
  operator mutations (operational updates). Fails soft (logs a warning, never blocks the request).
- **Backups:** **Not found in code** — this is a Supabase-platform-level concern (point-in-time
  recovery, if enabled, is a Supabase dashboard setting, not something the repo controls or
  documents). Confirm current backup/retention policy directly in Supabase; the codebase gives no
  visibility into it.
- **Version history:** no content versioning exists for `Venue`/`Place`/`VenueKnowledgeEntry` — an
  operator edit overwrites in place with no history table. `WeeklyReport` has a
  GENERATING/DRAFT/PUBLISHED status lifecycle but that's a single row's status, not multi-version
  history.

---

## 6. AI architecture

Every AI call site directly instantiates and calls the vendor SDK (`@anthropic-ai/sdk` or
`openai`) — there is **no shared provider-abstraction layer**, no centralized retry/cost module.
Each processor file duplicates its own client-singleton pattern and its own ad hoc
JSON-fence-stripping parse function. Response validation is inconsistent: some paths use Zod
schemas, some use manual guards, media-ingestion uses **no runtime validation at all**.
**No AI call anywhere in the codebase reads `response.usage` or tracks cost/tokens** — confirmed by
repo-wide grep; this is a real gap for per-client cost attribution at scale (see §9, §14).

### 6.1 Guest chat (synchronous, user-facing) — the core feature

- **Provider/model:** Anthropic, `claude-haiku-4-5-20251001` (`chat.ts:69`).
- **Prompt:** built by `buildVenueSystemPromptParts()` (`packages/api/src/lib/venue-context.ts`),
  split into a **cached** static block (venue identity/tone/rules, `cache_control: ephemeral`) and
  an **uncached** dynamic block (per-query retrieved places/knowledge/alerts/engagement prompt).
  This is the only call site in the codebase using prompt caching.
- **Input data:** venue identity/tone/operator notes, featured place, active operational alerts, up
  to 8 retrieved places, up to 5 knowledge entries, engagement-question instructions, language rule,
  last 10 messages of history.
- **Output:** plain text, **not streamed** (whole-response `await`, no SSE/websocket anywhere in the
  chat path), 512 max tokens, no temperature override. Post-processed: strip
  `[[ENGAGEMENT_ASKED]]` marker, hard-truncate to 60 words at a sentence boundary.
- **Fail-open:** any Claude error → canned apology string, never throws to the guest.
- **Unknown-answer handling:** no explicit refusal instruction beyond "ground answers in venue data,
  don't invent." A **backend-only, guest-invisible** low-confidence signal (pgvector distance
  threshold 0.55, or a regex "no info" pattern on the geo-fallback path) feeds a
  `message.low_confidence` analytics event for content-gap reporting — it does not change what the
  guest sees.
- **Rate limiting:** per-session 60/hour + per-venue 30/min, Redis-backed, degrades to an
  in-process in-memory counter (not multi-instance-safe) if Redis is unavailable.
- **Retrieval:** OpenAI `text-embedding-3-small` (1536-dim) embeds the query; pgvector cosine search
  over places + knowledge in parallel; geo/importance fallback if embedding generation fails.

### 6.2 "Curious mode" — AI-invented engagement questions (in-band with chat, no extra model call)

Tenant sets `engagementMode` (`STOIC`/`BALANCED`/`CURIOUS`); a per-turn probability gate
(0/0.35/0.5) decides whether to offer an authored question (intensity-weighted random pick) and/or,
in `CURIOUS` mode, let the model invent its own. Steered entirely by prompt instructions plus a
literal `[[ENGAGEMENT_ASKED]]` marker the model appends only when it actually asked — the marker is
gated server-side, not trusted blindly. The guest's next reply is captured as an
`EngagementQuestionResponse`, later summarized by the weekly-report and answer-analysis LLM jobs.

### 6.3 Background AI jobs (all Anthropic Sonnet unless noted; all Zod- or manually-validated JSON)

| Job                                        | Model                       | Max tokens | Guard/threshold         | Validation                          | Failure mode                               |
| ------------------------------------------ | --------------------------- | ---------- | ----------------------- | ----------------------------------- | ------------------------------------------ |
| `weekly-digest`                            | `claude-sonnet-4-6`         | 1,200      | skip if <5 sessions     | Zod, strict                         | fail-closed (job FAILED on parse error)    |
| `weekly-report`                            | `claude-sonnet-4-6`         | 1,800      | none                    | Zod + truncate-before-validate      | fail-closed                                |
| `answer-analysis`                          | `claude-sonnet-4-6`         | 1,500      | skip if <3 signal items | Zod + truncate-before-validate      | fail-closed                                |
| `analytics-enrichment` topic classifier    | `claude-haiku-4-5-20251001` | 1,024      | batches of 20           | manual JSON guard, no Zod           | fail-open per batch (skips, continues job) |
| `analytics-enrichment` weekly themes       | `claude-haiku-4-5-20251001` | 1,024      | ≥5 questions, once/week | Zod, strict                         | fail-open (keeps prior themes)             |
| `analytics-enrichment` question clustering | embeddings only (no LLM)    | n/a        | batches of 96           | pure math (cosine similarity ≥0.83) | n/a                                        |

Nightly `analytics-enrichment` explicitly documents its own cost discipline: "every LLM/embedding
call in this file is nightly, batched, and on cheap models... the live chat path gains NO new model
calls."

### 6.4 Media ingestion lab (OpenAI, admin-only, background, long-running)

Admin uploads a ZIP of venue photos/video/audio/docs + free-text context; the worker analyzes every
asset (vision model for images/video frames, transcription for audio) then synthesizes a draft
PathFinder import JSON (places, knowledge entries, unresolved questions, coverage). Provider JSON
is depth-, node-, property-, array-, key-, string-, and byte-bounded before strict Zod validation.
Per-asset failures are recorded and skipped (fail-open); job-level failures mark the whole project
FAILED (BullMQ retries ×3). Code-owned model contracts admit `gpt-5.6-luna` for
image/synthesis calls and `gpt-4o-mini-transcribe` for audio. Matching environment values may be
supplied, but arbitrary overrides fail before archive processing or provider dispatch.
Every provider dispatch writes canonical tenant/venue-attributed `AiUsageEvent` evidence with a
capability, versioned public price, observed tokens, latency, success/failure, and a normalized error
code. Billed responses rejected by bounded schema validation retain their observed usage as failures.
The project model's `estimatedCostCents`/`actualCostCents` fields remain unassigned legacy display
scaffolding and are not the canonical ledger.

### 6.5 Cross-cutting summary

| Call site                                 | Model                           | Latency class            | Streamed? | Cost tracked?        |
| ----------------------------------------- | ------------------------------- | ------------------------ | --------- | -------------------- |
| Guest chat                                | Claude Haiku 4.5                | synchronous, user-facing | No        | No                   |
| Curious-mode question                     | (same call as chat)             | synchronous              | No        | No                   |
| Weekly digest                             | Claude Sonnet 4.6               | background, weekly       | n/a       | No                   |
| Weekly report                             | Claude Sonnet 4.6               | background, on-demand    | n/a       | No                   |
| Answer analysis                           | Claude Sonnet 4.6               | background, on-demand    | n/a       | No                   |
| Topic classification                      | Claude Haiku 4.5                | background, nightly      | n/a       | No                   |
| Weekly theme synthesis                    | Claude Haiku 4.5                | background, weekly       | n/a       | No                   |
| Embeddings (chat + indexing + clustering) | OpenAI text-embedding-3-small   | mixed sync/async         | n/a       | No                   |
| Media analysis/synthesis                  | OpenAI `gpt-5.6-luna`           | background, long-running | n/a       | Yes (`AiUsageEvent`) |
| Media transcription                       | OpenAI `gpt-4o-mini-transcribe` | background               | n/a       | Yes (`AiUsageEvent`) |

**First-message latency** for guest chat is therefore the sum of: rate-limit check + session upsert

- (embedding call, parallel with history/alerts load) + pgvector search + one non-streamed Claude
  call (up to 512 output tokens) + two sequential DB writes. No streaming means the guest sees nothing
  until the entire Claude response is generated — this is the single biggest latency-perception lever
  available (see §9).

---

## 7. Deployment and infrastructure

> **2026-08-30 correction:** the table below is the historical 2026-08-05 inventory, not current
> staging truth. Current staging uses the three service-specific Docker configs
> `railway.staging.web.json`, `railway.staging.dashboard.json`, and
> `railway.staging.workers.json`; the exact active release and resource identities are maintained in
> `docs/system-state/TORCHIKO_STAGING_CURRENT_TRUTH_2026-08-30.md`. Root/app-scoped Nixpacks and
> non-staging configs are compatibility inputs and are not accepted by the staging verifier.

**Hosting: Railway.** Three services, two deployment strategies:

| Service     | Builder                                                                   | Source                                                  | Notes                                                                            |
| ----------- | ------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `dashboard` | Nixpacks (`nixpacks.toml` + `railway.json`/`apps/dashboard/railway.json`) | `pnpm --filter @pathfinder/dashboard build`             | duplicated/refined config exists at both repo root and app-scoped `railway.json` |
| `web`       | Dockerfile (`Dockerfile.web`)                                             | multi-stage `node:20-alpine`, `.next/standalone` output | port 8080                                                                        |
| `workers`   | Dockerfile (`Dockerfile.workers`)                                         | single-stage, `tsup` build, `node dist/index.js`        | no `EXPOSE` — no public URL, 5 restart retries (highest of the three)            |

All three use `restartPolicyType: ON_FAILURE`. **None of the Railway configs define a
`healthcheckPath`.** Redis is a separate Railway-hosted instance (BullMQ + rate limiting).

**Database:** Supabase Postgres. `DATABASE_URL` (pooled) at runtime, `DIRECT_DATABASE_URL` for
migrations. **Migrations are a manual runbook step** — `pnpm --filter @pathfinder/db
db:migrate:prod` must be run by hand against Supabase; confirmed by handoff docs describing pending
manual SQL steps via the Supabase SQL Editor. **Railway does not run migrations automatically.**

**No staging environment exists** — confirmed absence: no `staging` branch references, no
`.env.staging`, no second Railway service set, no staging-specific env vars. CI only distinguishes
`push` (any branch, runs checks) from `pull_request` (into `main`). This is a real gap for a
one-month scaling push that will likely touch schema/AI-prompt/billing-adjacent code.

**CI (`.github/workflows/ci.yml`):** on every push/PR — Postgres 16 service container, `pnpm
install` → `prisma generate` → `turbo run typecheck` → `turbo run lint` → `turbo run test`. No
build or deploy step (Railway's own GitHub integration presumably handles deploys, outside this
repo's visibility). Note: `REDIS_URL=redis://localhost:6379` is injected but **no Redis service
container is declared** — tests must mock BullMQ/Redis rather than exercising it live.
`apps/workers`'s `lint` script is a no-op placeholder (`echo lint:workers`) — **workers are not
actually linted in CI**, only typechecked/tested.

**Environment variables** (`packages/config/src/env.ts`, Zod-validated; skipped at Next.js build
time, enforced at runtime — a missing required var crashes the process on boot rather than failing
silently):

| Var                                                                            | Required | Role                                                         |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------ |
| `DATABASE_URL`                                                                 | yes      | pooled Postgres (Prisma runtime)                             |
| `DIRECT_DATABASE_URL`                                                          | yes      | direct Postgres (migrations only)                            |
| `REDIS_URL`                                                                    | no       | BullMQ + rate limiting; degrades gracefully if unset         |
| `CLERK_SECRET_KEY`                                                             | yes      | Clerk server auth                                            |
| `CLERK_PUBLISHABLE_KEY`                                                        | yes      | Clerk client auth                                            |
| `CLERK_WEBHOOK_SECRET`                                                         | no       | Svix signature verification for org/membership sync          |
| `ANTHROPIC_API_KEY`                                                            | no       | Claude calls (chat + all background AI jobs)                 |
| `OPENAI_API_KEY`                                                               | no       | embeddings + media-ingestion vision/transcription            |
| `MEDIA_ANALYSIS_MODEL` / `MEDIA_SYNTHESIS_MODEL` / `MEDIA_TRANSCRIPTION_MODEL` | no       | override the media-ingestion model IDs                       |
| `INTEGRATION_ENCRYPTION_KEY`                                                   | no       | for encrypting stored 3rd-party credentials (unused feature) |
| `STORAGE_BUCKET`/`REGION`/`ENDPOINT`/`ACCESS_KEY_ID`/`SECRET_ACCESS_KEY`       | no       | S3-compatible storage, used only by media-ingestion lab      |
| `POSTHOG_API_KEY`                                                              | no       | declared, **not wired** to any SDK                           |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL`                                         | no       | welcome-email sending                                        |
| `DASHBOARD_URL`                                                                | no       | base URL for generated links (e.g. in emails)                |

`.env.example` lists the same names (minus `DASHBOARD_URL`, a minor drift) with no real secret
values.

**Domains/branches:** not deep-dived in this pass — not discoverable from the repo alone (Railway
domain config lives in the Railway dashboard, not in-repo). **Rollback support** and **monitoring/
error reporting**: no Sentry or equivalent found anywhere in the codebase (grep returned zero
matches) — the only observability is the structured stdout logger and the `JobRecord` table for
worker visibility. This is a real gap at current scale and more so at 25–500 venues (see §9).

---

## 8. Security and privacy

### Positive controls (confirmed working)

- **Tenant isolation** is enforced at a single, well-tested Prisma-middleware chokepoint
  (`tenant-isolation.ts`), throwing on any tenanted-model call missing `tenant_id`. Bypass requires
  an explicit, auditable `withTenantIsolationBypass()` call, exercised only from `adminProcedure`
  handlers and tenant-filtered worker code.
- **`adminProcedure`** is a real, layered guard (`requireAuth` + `requirePlatformAdmin`, itself
  derived server-side from Clerk `publicMetadata`, never client input). Every admin router endpoint
  checked (~28 across both admin routers) uses it — none accidentally use a weaker procedure.
- **Impersonation cookie** (`pf_admin_tenant`) is `httpOnly`/`sameSite:lax`/`secure`-in-prod, set
  only after a server-side admin check, and honored in tRPC context only when
  `session.isPlatformAdmin === true` — a non-admin cannot leverage it even by setting it manually.
- **Clerk webhook** verifies Svix signatures, fails closed (401/500) rather than silently accepting
  unsigned events.
- **Every `$queryRaw`/`$executeRaw`** uses tagged-template parameter binding (no string
  concatenation found anywhere) and either binds `tenant_id` explicitly or carries a comment
  justifying a public cross-tenant lookup by an unguessable key.
- **Rate limiting** on the public chat endpoint, Redis-backed with a documented (if not
  multi-instance-safe) in-memory fallback rather than failing open with zero protection.
- **Input validation**: extensive Zod schemas, `.strict()` on public/tenant-facing inputs, explicit
  enum/length/size bounds (e.g., media-upload content-type restricted to `zip`, size capped).
- **Media-ingestion uploads**: tenant/venue/project-namespaced object keys, sanitized filenames
  (path-traversal-safe), short-lived (1hr) presigned URLs rather than server-proxied bytes.
- **Audit logging** on all sensitive admin mutations, fails soft rather than blocking the operation.

### Findings

| Severity      | Finding                                                                                                                                                                                                                                                                                                                                                                   | Location                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Low           | Media-ingestion upload declares its byte size as client-supplied metadata; nothing verifies the actual uploaded object size server-side after multipart completion. Blast radius is storage-cost abuse by a trusted admin (endpoint is `adminProcedure`-gated), not a cross-tenant/unauthenticated issue.                                                                 | `packages/api/src/routers/admin/media-ingestion.ts:130`, `packages/api/src/lib/media-storage.ts:38-55` |
| Low           | `admin.createClient` trusts a client-supplied `orgId`/`userId` without confirming they correspond to a real Clerk org/user (unlike its sibling `createClientAndVenue`, which does call Clerk). Could create a `Tenant` row pointing at a wrong/nonexistent Clerk org — a data-integrity risk, not a security-boundary bypass, since only a platform admin can trigger it. | `packages/api/src/routers/admin/_admin.ts:394-455`                                                     |
| Low           | `storePlaceEmbedding`/`storeKnowledgeEntryEmbedding` update by primary key with no `tenant_id` in the raw-SQL `WHERE`. Not exploitable today (every caller's `id` comes from a prior tenant-scoped query), but worth adding as defense-in-depth before the admin/API surface grows.                                                                                       | `packages/db/src/helpers/semantic-search.ts:131-136,187-195`                                           |
| Informational | `/admin/*` page shell (HTML/JS, not data) is reachable by any authenticated non-admin user for a brief render before the layout's server component redirects — no privileged data or action is exposed via that path since all data flows through gated tRPC calls, but it's a defense-in-depth gap worth closing at the middleware layer.                                | `apps/dashboard/middleware.ts:34`                                                                      |
| Informational | No monitoring/error-reporting service (Sentry or equivalent) integrated anywhere — incidents are only visible via stdout logs and the `JobRecord` table. Not a vulnerability, but limits incident-response speed.                                                                                                                                                         | repo-wide                                                                                              |
| Informational | No AI-call cost/usage tracking anywhere — not a security issue but a real operational-risk gap (unbounded spend visibility) once traffic scales; see §9.                                                                                                                                                                                                                  | repo-wide, confirmed by grep                                                                           |

**No instances were found** of: a tenant-scoped Prisma query missing `tenant_id` (the middleware
would throw before reaching the DB), raw SQL lacking either tenant binding or a justifying comment,
a `publicProcedure` returning tenant-private data without first resolving tenant identity from a
public/unguessable key, or any place where client input can set `role`/`isPlatformAdmin`/`tenantId`
directly.

### PII / chat-data retention

Guest messages are stored indefinitely by default — no retention/expiry job exists for
`Message`/`VisitorSession` rows (confirmed: no such processor among the 9 background queues).
Messages may contain whatever the guest chose to type (potentially PII if they mention names,
etc.); there is no redaction step. This is worth a deliberate retention-policy decision before
scaling to more venues/jurisdictions (GDPR-style "right to erasure" has no supporting tooling today).

---

## 9. Reliability and scalability

**Likely causes of slow chat responses today:**

1. **No streaming** — the guest waits for the full Claude response (up to 512 tokens) before seeing
   anything. This is the single biggest perceived-latency lever and the cheapest to fix.
2. **Sequential DB writes** after the Claude call (`Message` × 2, sequential by design to guarantee
   distinct timestamps) add latency after the model call has already returned — not itself slow, but
   stacks on top of a non-streamed response.
3. **Cold starts** on Railway/Next.js standalone containers — not measurable from the repo, but
   standard risk for low-traffic services that scale to zero or restart.
4. **In-memory rate-limit fallback** is not multi-instance-safe — if a service ever runs >1
   replica without Redis configured, per-venue/per-session limits become inconsistent across
   instances (each instance has its own counter).

**Retrieval bottlenecks:** pgvector search is a single index scan bound by `venue_id`+`tenant_id`
with a small `LIMIT` — this scales fine per-request but has no caching layer, so identical/near-
identical questions across guests at the same venue always re-embed and re-search rather than
reusing recent results.

**Missing queues/retries:** background jobs already have solid BullMQ retry/backoff coverage (6
attempts, exponential-ish backoff). The gap is on the **synchronous** path — the guest chat call has
no retry at all beyond the Anthropic SDK's built-in default (undocumented in this codebase), and a
transient Claude 5xx becomes an immediate canned-apology response to the guest rather than one quick
retry.

**Provider outages:** chat fails open (apology message) if Claude is down — acceptable UX
degradation. If OpenAI is down, embeddings fail open to geo/importance fallback — also acceptable.
If Redis is down, rate limiting degrades to (non-multi-instance-safe) in-memory — acceptable at low
scale, a real gap at multi-instance scale.

**Per-client cost attribution:** **does not exist.** No AI call anywhere reads `response.usage` or
persists token/cost data (confirmed by repo-wide grep, §6). At B2B SaaS scale this is the most
consequential gap for the "scaling effort" this document is meant to support — you cannot currently
answer "what does venue X cost us per month in AI spend" from the database.

**Multi-city / multi-venue scaling risks, roughly staged:**

| Scale           | Likely first breakage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **~25 venues**  | Nothing structural — current design comfortably handles this. Cost visibility gap becomes annoying (you're spending money you can't attribute) but not breaking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Tenant isolation, rate limiting, and BullMQ retries are all already correctly designed for this range.                  |
| **~100 venues** | (a) Nightly `analytics-enrichment`/`daily-rollup` cron jobs fan out **one job per active tenant**, sequentially enqueued in a loop (`enqueueScheduledWeeklyDigests`/`enqueueScheduledDailyRollups`/`enqueueScheduledAnalyticsEnrichment`, `apps/workers/src/index.ts`) — at 100 tenants this is still likely fine given concurrency 2 per queue, but the nightly window starts to matter. (b) In-memory rate-limit fallback becomes a real risk if/when a service scales to >1 replica. (c) No staging environment means every schema/prompt change ships straight to 100 live venues' worth of production chat traffic.                                                                                                                                                               | Nightly fan-out is O(tenants), not O(1); currently untested at this scale.                                              |
| **~500 venues** | (a) Nightly job fan-out (rollup + enrichment + digest, each looping all active tenants) likely exceeds its cron window or starts overlapping runs — no evidence of overlap protection beyond BullMQ's own job dedup via deterministic `jobId`s. (b) `pgvector` HNSW index performance and general Postgres connection-pool pressure (via the Supabase pooler) become real considerations without dedicated load testing — not evidenced in the repo either way. (c) Cost attribution gap becomes a business blocker, not just an annoyance — AI spend across 500 tenants needs per-tenant visibility to price/bill correctly. (d) Absence of a staging environment and of monitoring/alerting becomes untenable at this scale — a bad deploy is discovered by guests, not by an alert. | Structural: nightly-cron fan-out design, no staging, no monitoring, no cost tracking — all four compound at this scale. |

These are architectural estimates based on reading the current code, not load-test results — no
load testing exists in the repo to confirm actual breaking points.

---

## 10. Existing feature inventory

| Feature                                  | Status                                                                                                                   | Main files                                                                          | Confidence                     | Known limitations                                                                                                                                                                  | Recommended next action                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Visitor chat                             | Built, production                                                                                                        | `packages/api/src/routers/chat.ts`, `apps/web/app/[venueSlug]/chat/*`               | High                           | No streaming; no cost tracking; 60-word hard cap may feel terse                                                                                                                    | Add streaming; add usage tracking                                                              |
| Exhibits / guide items                   | **Not found** as a distinct model                                                                                        | —                                                                                   | High                           | Product uses `Place` + `VenueKnowledgeEntry` instead; architecture-doc vocabulary was never built                                                                                  | None — confirm this naming is intentionally retired                                            |
| Knowledge base                           | Built                                                                                                                    | `packages/api/src/routers/knowledge.ts`, `VenueKnowledgeEntry` model                | High                           | No versioning                                                                                                                                                                      | —                                                                                              |
| Guide notes                              | Built (`Venue.guideNotes`/`aiGuideNotes` fields)                                                                         | `prisma/schema.prisma`, `venue-context.ts`                                          | High                           | Single free-text field, no structure                                                                                                                                               | —                                                                                              |
| JSON import                              | Built                                                                                                                    | `apps/dashboard/components/VenueJsonImporter.tsx`, `bulkCreate` mutations           | Medium (not deep-read)         | 500-row cap; format not documented in this pass                                                                                                                                    | Read `VenueJsonImporter.tsx` directly before extending                                         |
| Client (operator) dashboard              | Built, production                                                                                                        | `apps/dashboard/app/(app)/*`                                                        | High                           | Largest components (PlaceForm etc.) are crowded/monolithic                                                                                                                         | Refactor form components before adding more screens                                            |
| Internal analytics                       | Built                                                                                                                    | `analytics` router, `DailyRollup`, `QuestionCluster`                                | High                           | No per-client cost data                                                                                                                                                            | Add cost/usage capture                                                                         |
| Weekly reports                           | Built, admin-triggered                                                                                                   | `weekly-report.ts` processor, `admin/_admin.ts`                                     | High                           | Sonnet-generated, no cost tracking                                                                                                                                                 | —                                                                                              |
| Answer analysis                          | Built, admin-triggered                                                                                                   | `answer-analysis.ts` processor                                                      | High                           | Same                                                                                                                                                                               | —                                                                                              |
| Operational updates                      | Built                                                                                                                    | `operational-update.ts` router                                                      | High                           | —                                                                                                                                                                                  | —                                                                                              |
| Branding customization                   | Built (chat theme/accent/font/logo/banner)                                                                               | `packages/ui/src/theme.ts`, `ChatDesignForm.tsx`                                    | High                           | Logo/banner are external URLs only, no upload                                                                                                                                      | Add upload if operators request it                                                             |
| Model configuration                      | Partial — models are hardcoded constants per call site, only media-ingestion models are env-overridable                  | `chat.ts:69`, `weekly-digest.ts:8`, etc.                                            | High                           | No per-venue model selection exists anywhere                                                                                                                                       | Needed for the "per-venue model selection" scaling goal — currently zero infrastructure for it |
| Location system                          | Built (GPS + geo fallback + haversine)                                                                                   | `apps/web/hooks/useGeolocation.ts`, `packages/api/src/lib/geo.ts`                   | High                           | —                                                                                                                                                                                  | —                                                                                              |
| Payments                                 | **Not found**                                                                                                            | —                                                                                   | High                           | `planTier`/`nextPaymentDue` are admin-editable fields only, no billing provider                                                                                                    | Needed before charging customers automatically                                                 |
| Tickets / change requests                | **Not found**                                                                                                            | —                                                                                   | High                           | —                                                                                                                                                                                  | —                                                                                              |
| API / widget integration                 | **Not found** — no embeddable widget, no public authenticated API beyond the guest tRPC surface                          | —                                                                                   | High                           | —                                                                                                                                                                                  | Needed for the "embeddable widget" scaling goal                                                |
| Voice mode                               | **Not found**                                                                                                            | —                                                                                   | High                           | Media-ingestion lab does transcription for _ingestion_, not live voice chat                                                                                                        | Net-new feature                                                                                |
| Public marketing website                 | Minimal — `apps/web/app/page.tsx` is a static landing page                                                               | `apps/web/app/page.tsx`                                                             | High                           | Very thin; not a full marketing site                                                                                                                                               | —                                                                                              |
| Authentication                           | Built (Clerk)                                                                                                            | `packages/auth/*`                                                                   | High                           | —                                                                                                                                                                                  | —                                                                                              |
| Monitoring                               | **Not found** (no Sentry/equivalent)                                                                                     | —                                                                                   | High                           | Only stdout logs + `JobRecord`                                                                                                                                                     | Add before scaling past ~100 venues                                                            |
| Backups                                  | Not visible in code (Supabase platform concern)                                                                          | —                                                                                   | Low (out of repo's visibility) | —                                                                                                                                                                                  | Confirm Supabase backup/PITR settings directly                                                 |
| Version history                          | **Not found** for venue/place/knowledge content                                                                          | —                                                                                   | High                           | Edits overwrite in place                                                                                                                                                           | Consider before allowing more editors per tenant                                               |
| Source tracking                          | Partial — `MediaIngestionAsset.sourceId`/`sha256` track ingestion provenance; no equivalent for manually-entered content | `MediaIngestionAsset` model                                                         | Medium                         | —                                                                                                                                                                                  | —                                                                                              |
| Automated quality testing (of AI output) | **Not found** — no eval harness for chat quality/prompt regressions                                                      | —                                                                                   | High                           | Unit tests cover code paths, not AI response quality                                                                                                                               | Needed before iterating on prompts at scale                                                    |
| Media ingestion lab                      | Built, admin-only, experimental                                                                                          | `admin/media-ingestion.ts`, `apps/workers/src/processors/media-ingestion.ts`        | High                           | Reviewed model IDs, bounded output validation, canonical usage accounting, and optional tenant hard-budget reservations are present; legacy project cost fields remain unpopulated | Approve representative media and any separate commercial media-tier policy before activation   |
| Engagement questions / "curious mode"    | Built, in production prompt logic                                                                                        | `engagement-question.ts`, `packages/api/src/lib/engagement-questions.ts`, `chat.ts` | High                           | AI-invented question quality untested at scale                                                                                                                                     | —                                                                                              |

---

## 11. Technical debt and duplication

- **Provider coupling spread across 6+ files** — every AI call site (`chat.ts`, `weekly-digest.ts`,
  `weekly-report.ts`, `answer-analysis.ts`, `analytics-enrichment.ts`, `media-ingestion.ts`)
  duplicates its own client-singleton instantiation and its own JSON-fence-stripping parser
  (`parseDigestInsights`, `parseReport`, `parseAnalysis`, `parseTopicAssignments`,
  `parseWeeklyThemes`, `parseJson`). This is the top item to consolidate before adding per-venue
  model selection or provider-independence — right now there is no seam to insert either.
- **Inconsistent AI output validation** — Zod schemas in weekly-digest/weekly-report/answer-analysis
  and the theme-synthesis path; manual guards in the topic classifier; **no validation at all** in
  media-ingestion. Standardize on Zod everywhere.
- **Dead cost-tracking scaffolding** — `estimatedCostCents`/`actualCostCents` on
  `MediaIngestionProject`, displayed in the admin UI, never written by any worker.
- **Unused placeholder table** — `DataAdapter` (integration framework never built).
- **Empty feature-flag registry** — `TenantFeatureFlag` table + helpers exist; the key registry that
  would make them useful is empty, so nothing is actually gated today.
- **Overly large dashboard components** — `PlaceForm.tsx` (713 lines), `EngagementQuestionsManager.tsx`
  (532), `VenueForm.tsx` (422) each combine form, validation, and data-access in one file; this
  pattern repeats across the dashboard's largest ~9 components (§3).
- **tRPC client inconsistency** — dashboard mixes `createTRPCReact` (React-Query hooks) with a
  vanilla `createTRPCClient()` instantiated per-component (no shared instance/hook), matching the
  pattern web also uses. Worth picking one approach.
- **Duplicate PWA manifest sources** — `apps/web/app/manifest.ts` (Next-generated) and
  `apps/web/public/manifest.webmanifest` (static) both exist; `layout.tsx` links the static one
  explicitly — a drift risk if only one gets updated.
- **`apps/workers` lint is a no-op** (`echo lint:workers`) — not actually enforced in CI, unlike
  every other package/app.
- **Hardcoded model strings** scattered as literals per file rather than centralized constants —
  makes "per-venue model selection" (a named scaling goal) currently impossible without touching
  every call site.
- **Documentation drift** — `CLAUDE.md`'s tenanted-table list is stale (10 of 21 actual tables
  listed); `CLAUDE.md` and older docs still describe a separate `apps/admin` deployment that no
  longer exists in the repo.
- **Manual, undocumented production migration process** — no runbook exists in `docs/`; the process
  is reconstructed from ad hoc handoff notes (`docs/analytics-rework-handoff.md`,
  `docs/codex-backlog.md`).

---

## 12. Tests

**Existing coverage** (Confirmed, 31 `*.test.ts(x)` files found repo-wide):

- **Unit/integration**, well-distributed across `packages/api/src/routers` (chat, including a
  dedicated `chat.low-confidence.test.ts`; venue, place, knowledge, operational-update,
  engagement-question, analytics, tenant, admin `_admin`, admin media-ingestion), `packages/db/src/
helpers` (audit, embeddings, feature-flags, job-records, membership-sync, semantic-search),
  `packages/db/src/middleware/tenant-isolation.test.ts` (the critical control — well covered:
  create/createMany/upsert/update/delete/find\*, platform tables, bypass), `packages/auth`
  (permissions, session), `packages/api/src/lib` (engagement-questions, geo, rate-limit,
  venue-context), `packages/ui/src/theme.test.ts`.
- **Worker processor tests**: `analytics-enrichment.test.ts`, `embed-place.test.ts`,
  `send-welcome-email.test.ts` — the other 6 processors (daily-rollup, weekly-digest, weekly-report,
  answer-analysis, embed-knowledge-entry, media-ingestion) have **no dedicated test file** found.
- **Frontend**: only 3 test files exist (`QuickPromptChips.test.tsx`, `useGeolocation.test.tsx`,
  `useSession.test.tsx`) — the large dashboard form components (PlaceForm, VenueForm,
  EngagementQuestionsManager, etc.) have **no tests**.

**Not found:**

- End-to-end tests (no Playwright/Cypress config found in the repo).
- AI evaluation tests (no eval harness scoring chat-response quality, prompt regressions, or
  hallucination rate).
- Import-format tests specifically for the JSON importer flow.
- Deployment smoke tests (CI runs typecheck/lint/test only; no post-deploy health check).

**Most important gaps to close before the scaling push:**

1. **AI evaluation harness** — nothing currently catches a prompt-quality regression before it
   reaches guests; this matters more as the team iterates on prompts under time pressure.
2. **Weekly-digest/weekly-report/answer-analysis/media-ingestion processor tests** — these are the
   newest, most complex background jobs (multi-step Zod parsing with truncate-before-validate
   fallbacks) and are among the least tested.
3. **Dashboard form-component tests** — the largest, most crowded components have zero test
   coverage, which raises the risk of any refactor recommended in §11.
4. **A deployment smoke test** (e.g., hit `health` query + one cheap chat call against staging)
   would partially compensate for the missing staging environment and missing monitoring.

---

## 13. Recommended architecture direction

Favor **incremental improvement**, not a rewrite — the core design (tenant isolation middleware,
tRPC-everything, BullMQ background jobs, fail-open AI calls) is sound and should be preserved.
Concrete, staged recommendations toward the stated scaling goals:

1. **Separate public website / client portal / internal operations portal** — the current
   `(app)`/`(admin)` merge inside one dashboard app is a reasonable low-scale choice but becomes a
   liability as admin tooling grows (media ingestion lab is already the single largest admin
   component). Given `apps/admin` already existed once, consider re-splitting it out as its own
   Railway service once the admin surface justifies a separate deploy cadence — but only after the
   `adminProcedure` boundary (already the real security control) is confirmed sufficient on its own;
   don't rely on app-separation as the security boundary, just as an operational one.
2. **Multi-tenant isolation** — already solid (§5, §8). No structural change needed; add
   `tenant_id` to the two raw-SQL embedding-store `WHERE` clauses as cheap defense-in-depth.
3. **Provider-independent AI calls** — introduce one thin internal wrapper module per provider
   (`packages/api/src/lib/ai/anthropic.ts`, `.../openai.ts`) that centralizes client instantiation,
   retry policy, `response.usage` capture, and JSON-parsing/Zod-validation helpers. Every existing
   call site becomes a call into this module. This single change also unlocks #4 and #5 below.
4. **Per-venue model selection** — once model strings are centralized (via #3), add a
   `Venue.aiModelOverride` (or `Tenant`-level default + `Venue`-level override) column and thread it
   through the wrapper. Currently there is zero infrastructure for this — it requires #3 first.
5. **Per-client usage and cost tracking** — now implemented through append-only `AiUsageEvent`,
   tenant/venue daily rollups, fixed-point tenant budget reservations, and provider-owned pricing
   versions. Guest, worker, embedding, evaluation, voice, and media paths retain their applicable
   token/audio/cost evidence. These estimates remain operational evidence rather than invoices or
   an authorization for usage-based customer pricing.
6. **Background job processing** — already solid (BullMQ, retries, `JobRecord`). At 500-venue scale,
   revisit the nightly per-tenant fan-out loops (§9) — consider batching or sharding the cron
   schedulers rather than one job per tenant per night.
7. **Automated reports / operational updates** — already built; the main gap is validation
   consistency (§11) and an eval harness (§12), not new infrastructure.
8. **Embeddable website widget** — net-new. Design as a separate, minimal, unauthenticated
   `publicProcedure` surface (reuse `chat.send`/`chat.history` as-is) behind a lightweight
   CORS-scoped iframe or script-embed, rather than a new app.
9. **Authenticated API** — net-new. If planning a real partner-facing API (beyond the guest chat
   surface), introduce API keys scoped to a tenant, validated in a new tRPC middleware sitting
   alongside `tenantProcedure`, reusing all existing tenant-scoped routers rather than duplicating
   logic.
10. **App web-view integration** — the existing PWA (`apps/web`) is already a reasonable web-view
    target; no separate native shell exists or is evidenced as needed yet.
11. **Voice mode** — net-new; the media-ingestion pipeline's transcription code
    (`media-ingestion.ts`'s `transcribe()`) is a starting reference for STT, but live voice chat
    would need its own low-latency streaming design, which also motivates #12 (streaming chat
    responses) as a prerequisite.
12. **Staging and production** — highest-priority infrastructure gap. Stand up a second Railway
    project (or environment) mirroring the three services + a separate Supabase project, wire CI to
    deploy `main` there automatically, and gate production deploys behind a manual promote step.
13. **Monitoring and rollback** — add an error-reporting SDK (Sentry or equivalent) to all three
    services, add `healthcheckPath` to the Railway configs (a `health` tRPC query already exists per
    `docs/codebase-overview.md:140` — wire it to an actual HTTP health endpoint Railway can poll),
    and document/automate the rollback path (Railway supports redeploying a prior build; currently
    undocumented in-repo).
14. **Version history and backups** — add a lightweight version table for `Venue`/`Place`/
    `VenueKnowledgeEntry` edits (append-only, like `AuditLog`) before opening up multi-editor
    workflows per tenant; confirm and document Supabase's backup/PITR configuration directly (not
    visible from the repo).
15. **Automated venue-specific testing** — build the AI eval harness named in §12 as a first step;
    extend it to a small per-venue smoke-test set (a handful of known Q&A pairs per venue category)
    that can run in CI/staging before a prompt or model change ships to all tenants.

---

## 14. Prioritized findings

### Immediate blockers before live rollout (of a wider scaling push)

- No AI cost/usage tracking anywhere — cannot answer "what does this venue cost us" today; blocks
  any usage-based pricing or cost-alerting work.
- No staging environment — every change currently ships straight to production chat traffic.
- No monitoring/error-reporting service — incidents are only visible via stdout logs; blocks fast
  incident response at higher venue counts.
- Media-ingestion project cost fields remain unpopulated; approve a commercial budget policy and
  versioned accounting contract before relying on the lab for onboarding at scale.

### Important improvements during the next month

- Centralize AI provider calls into one wrapper (unlocks cost tracking, per-venue model selection,
  and consistent output validation in one move).
- Add `healthcheckPath` to all three Railway service configs.
- Stream the guest chat response (biggest single latency-perception win, and a prerequisite for
  voice mode later).
- Refactor the largest dashboard components (`PlaceForm.tsx` and siblings) before adding more
  operator screens.
- Add test coverage for the untested background processors (daily-rollup, weekly-digest,
  weekly-report, answer-analysis, embed-knowledge-entry, media-ingestion) and the large dashboard
  forms.
- Add `tenant_id` to the two raw-SQL embedding-store `WHERE` clauses as defense-in-depth.
- Fix `CLAUDE.md`'s stale tenanted-table list and its reference to a separate `apps/admin`
  deployment that no longer exists.

### Valuable later additions

- Embeddable website widget and authenticated partner API (§13 #8–9).
- Voice mode, once streaming chat exists as a foundation.
- Version history for venue/place/knowledge content.
- Per-venue automated smoke-test suite feeding off the new AI eval harness.
- Re-evaluate nightly per-tenant job fan-out design ahead of ~500-venue scale.

### Questions the codebase cannot answer

- Actual current Supabase backup/PITR configuration and retention policy.
- Actual production domain names, DNS, and Railway environment/project layout beyond what's in
  `railway*.json`.
- Actual representative media-ingestion cost per file and venue; the technical 10,000-operation
  ceiling is not a commercial budget.
- Real-world chat latency numbers (no APM/tracing exists in-repo to derive these from).
- Actual current guest chat traffic volume / venue count, needed to calibrate how urgent the ~25 /
  100 / 500-venue risk staging in §9 really is.
- Chat-data retention/PII policy intent — no retention job exists, but whether that's a deliberate
  choice or an oversight isn't discoverable from code alone.

### Files another AI (or engineer) should read first

1. `packages/api/src/routers/chat.ts` — the core product path, dense but the single most important file.
2. `packages/api/src/lib/venue-context.ts` — the prompt builder.
3. `packages/db/src/middleware/tenant-isolation.ts` + `tenanted-tables.ts` — the security chokepoint.
4. `packages/db/prisma/schema.prisma` — full data model.
5. `apps/workers/src/index.ts` — job scheduling/registration, the shape of all background work.
6. `packages/config/src/env.ts` — every env var and what depends on it.
7. `apps/workers/src/processors/media-ingestion.ts` — the newest, least-tested, most complex feature.
8. `docs/codebase-overview.md` — a good, mostly-current companion narrative (missing the newest
   tables/features this document adds: knowledge base, engagement questions, weekly reports, answer
   analysis, media ingestion lab).

## 2026-08-20 CRM and outreach addendum

The correction branch contains a platform-owned, Postgres-canonical prospect CRM with opportunity-owned workflow state, normalized contactability history, multi-location customer relationships, exact campaign cohorts, immutable frozen batches, a transactional send outbox, and verified read/draft-only Agent Run tools. Gmail is the only permitted prospect provider behind a provider-neutral boundary; Resend remains transactional/opted-in only. Production Gmail OAuth/Pub/Sub/scheduler composition and real delivery are not implemented, and delivery is dark by default. See `docs/sales/PROSPECT_CRM_ARCHITECTURE.md` and `docs/sales/PROSPECT_OUTREACH_OPERATIONS.md`.
