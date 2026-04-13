# PathFinderOS — Analytics & Insights Implementation Plan

> Version: 1.0
> Date: 2026-04-13
> Status: Canonical execution reference
> Intended consumers: Codex, AI coding agents, engineering leads
> Read `/docs/architecture.md` and `/docs/implementation-plan.md` before starting any phase.
> Read `CLAUDE.md` in full — all rules in that file apply to every phase here.

---

## Overview

This plan implements a two-tier analytics system for PathFinderOS:

**Tier 1 — Consistent Metrics:** Automated daily rollups that produce comparable KPIs over time (sessions, top places, busy hours, unanswered questions). These populate the `DailyRollup` table that already exists in the schema.

**Tier 2 — Weekly AI Digest:** Every Sunday night a BullMQ worker reads the past 7 days of raw conversation data per tenant and sends it to Claude. Claude returns structured JSON with plain-English insights, trends, and recommendations. This is stored in a new `WeeklyDigest` table and displayed on the dashboard every Monday morning.

The digest is the core product differentiator. Tier 1 metrics are the supporting context.

---

## Architectural constraints (do not violate)

- All business logic lives in `packages/api/src/routers/`. No exceptions.
- All DB access goes through `{ db }` from `@pathfinder/db`. Never instantiate PrismaClient directly.
- All async/background work is queued via `packages/jobs/src/enqueue.ts`. Never import BullMQ directly outside `apps/workers`.
- Analytics dashboard queries read from `DailyRollup` or `WeeklyDigest` — never from `messages`, `guest_sessions`, or `venues` OLTP tables for aggregates.
- `emitEvent()` is called server-side only, after mutations succeed.
- Every new tenanted table must be added to the tenant isolation middleware list in `packages/db/src/middleware/tenant-isolation.ts`.
- Queue names are constants in `packages/jobs/src/queues.ts`. Never use string literals elsewhere.
- Job payload types are defined in `packages/jobs/src/types.ts`.

---

## Phase 1 — WeeklyDigest schema and migration

**Goal:** Add the `WeeklyDigest` table to the database.

### Tasks

1. Add the following model to `packages/db/prisma/schema.prisma`:

```prisma
model WeeklyDigest {
  id          String   @id @default(cuid())
  tenantId    String   @map("tenant_id")
  weekStart   DateTime @map("week_start") // Monday 00:00:00 UTC of the week being analyzed
  weekEnd     DateTime @map("week_end")   // Sunday 23:59:59 UTC of the week being analyzed
  status      WeeklyDigestStatus @default(PENDING)
  sessionCount     Int @default(0) @map("session_count")
  messageCount     Int @default(0) @map("message_count")
  insights    Json     @default("[]") // Array of { title, body, type: 'trend'|'confusion'|'interest'|'recommendation' }
  generatedAt DateTime? @map("generated_at")
  createdAt   DateTime @default(now()) @map("created_at")
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  @@unique([tenantId, weekStart])
  @@index([tenantId, weekStart])
  @@map("weekly_digests")
}

enum WeeklyDigestStatus {
  PENDING
  PROCESSING
  COMPLETE
  FAILED
}
```

2. Add `weeklyDigests WeeklyDigest[]` to the `Tenant` model relation list.

3. Run the migration from `packages/db`:
```bash
pnpm db:migrate
```
Name it: `add_weekly_digest`

4. Add `WeeklyDigest` and `WeeklyDigestStatus` to the tenanted tables list in `packages/db/src/middleware/tenant-isolation.ts`.

5. Export `WeeklyDigest` and `WeeklyDigestStatus` types from `packages/db/src/index.ts`.

### Acceptance criteria
- `pnpm turbo run typecheck` passes with zero errors.
- `pnpm db:migrate` applies cleanly.
- `WeeklyDigest` appears in the tenant isolation middleware tenanted tables list.

---

## Phase 2 — Job infrastructure

**Goal:** Define the queue, job types, and enqueue helper for the weekly digest job.

### Tasks

1. In `packages/jobs/src/queues.ts`, add a constant:
```ts
export const WEEKLY_DIGEST_QUEUE = 'weekly-digest'
```

2. In `packages/jobs/src/types.ts`, add a job payload type:
```ts
export type WeeklyDigestJobPayload = {
  tenantId: string
  weekStart: string // ISO date string — Monday 00:00:00 UTC
  weekEnd: string   // ISO date string — Sunday 23:59:59 UTC
  digestId: string  // WeeklyDigest row ID — created before job is enqueued
}
```

3. In `packages/jobs/src/enqueue.ts`, add an export:
```ts
export async function enqueueWeeklyDigest(payload: WeeklyDigestJobPayload): Promise<void>
```
Follow the existing pattern in that file for other job types.

4. In `apps/workers/src/index.ts`, register a repeatable BullMQ job that fires every Sunday at 23:00 UTC:
```ts
cron: '0 23 * * 0'
```
This job loops over all active tenants and enqueues one `WeeklyDigestJobPayload` per tenant.

### Acceptance criteria
- `pnpm turbo run typecheck` passes.
- No BullMQ imports outside `apps/workers` and `packages/jobs`.
- Queue name used only via the constant, never as a string literal.

---

## Phase 3 — Weekly digest worker

**Goal:** Implement the worker that processes a `WeeklyDigestJobPayload` — queries conversation data, calls Claude, and writes the result.

### File to create
`apps/workers/src/processors/weekly-digest.ts`

### Tasks

1. The processor receives a `WeeklyDigestJobPayload`. It must:

   a. Mark the `WeeklyDigest` row as `PROCESSING`.

   b. Query all `GuestSession` rows for the tenant in the week range. For each session, include related `Message` rows (both user and assistant turns). Use `withTenantIsolationBypass` since this runs outside a tRPC request context.

   c. If there are fewer than 5 sessions, write a digest with status `COMPLETE`, zero insights, and a note that there is insufficient data. Do not call Claude.

   d. Build a structured prompt for Claude. The prompt must:
   - Summarize the conversation data as a JSON array of sessions, each with an array of messages (role + content)
   - Instruct Claude to return a JSON object matching this exact shape:
     ```json
     {
       "insights": [
         {
           "type": "trend | confusion | interest | recommendation",
           "title": "Short headline (max 10 words)",
           "body": "Plain English explanation (2-4 sentences). Be specific — include counts, place names, and times where relevant. Write for a venue manager, not a data analyst."
         }
       ]
     }
     ```
   - Instruct Claude to produce 3–8 insights total
   - Instruct Claude to focus on: things guests were confused about, places or topics guests showed unusual interest in, patterns by time of day or day of week, questions the venue should answer with better signage or information, and anything surprising or anomalous
   - Instruct Claude to never invent data — only report what is present in the conversations

   e. Call Claude using `@anthropic-ai/sdk` with model `claude-opus-4-6`. Use streaming off (regular `.messages.create()`). Parse the JSON from the response.

   f. Update the `WeeklyDigest` row:
   - `status: 'COMPLETE'`
   - `insights`: the parsed JSON array
   - `sessionCount`: number of sessions analyzed
   - `messageCount`: total message count across all sessions
   - `generatedAt`: now

   g. On any error: mark the digest `FAILED`, log the error with `tenantId` and `digestId`, and rethrow so BullMQ applies the retry schedule.

2. Write a `JobRecord` row on completion (success or failure) — see existing workers for the pattern.

3. Register this processor in `apps/workers/src/index.ts` on the `WEEKLY_DIGEST_QUEUE`.

### Prompt quality notes (important)
The Claude prompt is the core product. These details matter:
- Tell Claude the tenant's venue name and type (query it from the `Tenant` / `Venue` table) so insights are contextual ("guests at Auckland Zoo asked about...")
- Cap the message content sent to Claude at 500 chars per message to control token usage
- Tell Claude to produce insight `type` values from the fixed enum: `trend`, `confusion`, `interest`, `recommendation`
- Ask Claude to order insights by importance (most actionable first)

### Acceptance criteria
- Worker processes a job and writes a `COMPLETE` digest with valid JSON insights.
- Worker handles < 5 sessions gracefully without calling Claude.
- Worker marks digest `FAILED` on Claude API error and does not swallow the error.
- `pnpm turbo run typecheck` passes.

---

## Phase 4 — tRPC analytics router

**Goal:** Expose digest and metrics data to the dashboard via tRPC.

### File to create or extend
`packages/api/src/routers/analytics.ts` (already exists — add procedures to it)

### Tasks

1. Add `analytics.getLatestDigest` — `tenantProcedure`, no input. Returns the most recent `WeeklyDigest` row for the active tenant where `status = 'COMPLETE'`. Returns `null` if none exists.

2. Add `analytics.listDigests` — `tenantProcedure`, no input. Returns the last 8 `WeeklyDigest` rows for the tenant (for a history view), ordered by `weekStart` descending. Returns only: `id`, `weekStart`, `weekEnd`, `status`, `sessionCount`, `messageCount`, `generatedAt`. Does not return `insights` (too large for a list).

3. Add `analytics.getDigest` — `tenantProcedure`, input: `{ id: z.string() }`. Returns the full digest including `insights`. Validates `tenantId` matches `ctx.activeTenantId` — throw `FORBIDDEN` if not.

4. Add `analytics.getDailyStats` — `tenantProcedure`, input: `{ days: z.number().min(7).max(90).default(30) }`. Returns the last N days of `DailyRollup` rows for the tenant, ordered by date ascending. This powers the Tier 1 trend charts.

### Acceptance criteria
- All four procedures exist and return correct types.
- `getDigest` throws `FORBIDDEN` if the digest belongs to a different tenant.
- `pnpm turbo run typecheck` passes.
- Each procedure has at least one test for the forbidden path.

---

## Phase 5 — Dashboard analytics UI

**Goal:** Build the analytics page on the client dashboard.

### Page location
`apps/dashboard/app/(app)/analytics/page.tsx`

### Tasks

1. **Weekly Digest card (primary, top of page)**

   Fetches `analytics.getLatestDigest`. Displays:
   - Week range (e.g. "Week of Apr 7 – Apr 13")
   - Session count and message count as small stats
   - Each insight as a card with:
     - A color-coded badge for `type` (trend = blue, confusion = red, interest = green, recommendation = amber)
     - The `title` in bold
     - The `body` in regular text
   - If no digest exists yet: empty state — "Your first weekly digest will appear here after Sunday night."
   - If digest status is `PROCESSING`: "This week's digest is being generated..."

2. **Past digests list (collapsible, below the main card)**

   Fetches `analytics.listDigests`. Shows a simple list of past weeks with session/message counts. Clicking a row fetches and displays that week's full digest inline.

3. **Daily stats section (Tier 1 metrics)**

   Fetches `analytics.getDailyStats` with `days: 30`. Displays:
   - Sessions per day (line chart or bar chart — use a simple recharts component)
   - If `DailyRollup` is empty: show placeholder "Analytics data will appear once guests start using PathFinder."

4. Use `packages/ui` components where they exist. Follow the existing dashboard visual style (slate sidebar, card-based layout, cyan accent).

5. Do not put any data fetching logic in `packages/ui` components. All data is fetched in the page and passed as props.

### Acceptance criteria
- Page renders without error when no digest exists.
- Page renders all insights correctly when a digest exists.
- Page is not accessible to unauthenticated users (handled by existing layout).
- `pnpm turbo run typecheck` passes.

---

## Phase 6 — Manual digest trigger (admin)

**Goal:** Let the platform admin manually trigger a digest for any tenant from the Clients page — useful for testing and for generating an initial digest for a new client without waiting for Sunday.

### Tasks

1. Add `admin.triggerDigest` procedure to `packages/api/src/routers/admin/_admin.ts`:
   - `adminProcedure`, input: `{ tenantId: z.string() }`
   - Creates a `WeeklyDigest` row for the current week (if one doesn't already exist) with status `PENDING`
   - Enqueues a `WeeklyDigestJobPayload` via `enqueueWeeklyDigest()`
   - Returns `{ digestId: string }`

2. Add a "Generate Digest" button to the `ClientsPanel` component next to each client. On click, calls `admin.triggerDigest`. Shows a success toast or inline confirmation.

### Acceptance criteria
- Clicking "Generate Digest" on the clients page enqueues a job.
- The digest row appears in the tenant's analytics page within the worker's processing time.
- `pnpm turbo run typecheck` passes.

---

## Phase 7 — DailyRollup worker (Tier 1)

**Goal:** Populate the `DailyRollup` table nightly so Tier 1 charts have data.

### File to create
`apps/workers/src/processors/daily-rollup.ts`

### Tasks

1. Add `DAILY_ROLLUP_QUEUE = 'daily-rollup'` to `packages/jobs/src/queues.ts`.

2. Add `DailyRollupJobPayload = { tenantId: string; date: string }` to `packages/jobs/src/types.ts`.

3. Add `enqueueDailyRollup` to `packages/jobs/src/enqueue.ts`.

4. Register a repeatable job in `apps/workers/src/index.ts` — fires daily at 01:00 UTC, cron: `'0 1 * * *'`. Loops all active tenants and enqueues one `DailyRollupJobPayload` per tenant for yesterday's date.

5. The processor:
   - Queries `GuestSession` for the tenant on the given date
   - Counts: total sessions, total messages, unique place mentions (extracted from message content by looking for place names that exist in the `Place` table for that tenant)
   - Upserts a `DailyRollup` row for that tenant + date
   - Writes a `JobRecord` on completion

### Note on place mention extraction
Keep this simple in v1: do a case-insensitive substring search of message content against all place names for the tenant. Do not use embeddings or NLP. This can be improved later.

### Acceptance criteria
- Worker runs and upserts `DailyRollup` rows without error.
- Re-running for the same date upserts (does not duplicate).
- `pnpm turbo run typecheck` passes.

---

## Implementation order

Do the phases in order. Each phase is a PR. Do not combine phases.

| Phase | Depends on |
|-------|-----------|
| 1 — Schema | Nothing |
| 2 — Job infrastructure | Phase 1 |
| 3 — Digest worker | Phase 2 |
| 4 — tRPC router | Phase 1 |
| 5 — Dashboard UI | Phase 4 |
| 6 — Manual trigger | Phase 3, Phase 4 |
| 7 — Daily rollup | Phase 2 |

Phases 4 and 2 can be done in parallel after Phase 1. Phase 5 can start after Phase 4 with stub data.

---

## PR checklist for every phase

- [ ] `pnpm turbo run typecheck` — zero errors
- [ ] `pnpm turbo run lint` — zero errors  
- [ ] New tenanted tables added to isolation middleware
- [ ] No `PrismaClient` instantiated outside `packages/db`
- [ ] No BullMQ imported outside `apps/workers` and `packages/jobs`
- [ ] Queue names used via constants only
- [ ] No `throw new Error()` in tRPC procedures — use `TRPCError`
- [ ] New procedures have a forbidden-path test
- [ ] `emitEvent()` not called from client components

---

*End of analytics implementation plan.*
