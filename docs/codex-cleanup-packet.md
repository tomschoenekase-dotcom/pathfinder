# Codex Task Packet — Large-Scale Cleanup (Items 1–7)

> **Audience:** ChatGPT Codex.
> **Source of truth for current architecture:** [`docs/codebase-overview.md`](./codebase-overview.md).
> Read it fully before starting. It describes what the code _actually is_ (an AI venue-guide
> chatbot), which differs from the older `docs/architecture.md` (which describes an unbuilt generic
> SaaS). Where they conflict, the overview + the real code win.
>
> **This packet contains 7 independent-ish tasks.** Do them as separate commits in the order given.
> Each has its own acceptance criteria. Do not bundle unrelated changes.

---

## ⚠️ Coordination boundaries — READ FIRST

A parallel effort (the admin console + operational hardening) is happening at the same time.
To avoid merge conflicts, **you must not touch these paths or files:**

- `apps/admin/**` — entire admin app is being rebuilt in parallel. Leave it completely alone.
- `packages/api/src/routers/admin/**` — admin tRPC procedures are being expanded in parallel.
- `packages/api/src/lib/rate-limit.ts` and its test — parallel hardening.
- `packages/config/src/env.ts` — parallel env work.

Specific consequences for the tasks below:

- **Item 6 (component dedup):** cover **`apps/web` and `apps/dashboard` only**. Do **not** dedup or
  modify `apps/admin`’s components — admin will be wired to `packages/ui` separately.
- **Item 7 (session model):** `GuestSession` is being removed. The parallel admin work will read
  session/message activity from `VisitorSession`, `Message`, and `DailyRollup` — **never** from
  `GuestSession`. Preserve per-session activity tracking on `VisitorSession` (details in Item 7).

If a task seems to require touching a forbidden path, **stop and leave a note in the PR description
instead of editing it.**

---

## Verification (run after every task)

From the repo root:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

All three must be clean before moving to the next task. The project is TypeScript strict with
`exactOptionalPropertyTypes` — never pass `undefined` into Prisma data; use the existing
`...(x !== undefined ? { x } : {})` spread pattern you’ll see throughout the codebase.

---

## Item 1 — Rewrite `CLAUDE.md` and reconcile `architecture.md` to reality

**Why:** `CLAUDE.md` is the engineering constitution every coding agent follows. It currently
describes tables and subsystems that don’t exist (`Listing`, `Booking`, `Event`, `GuestUser`,
`AvailabilitySlot`, the `IntegrationAdapter` framework, S3 uploads, etc.). This actively misleads
every future change. The real product is an AI venue-guide chatbot.

**Files:**

- `CLAUDE.md` (rewrite)
- `docs/architecture.md` (add a status banner; do **not** delete — keep as historical design intent)

**Steps:**

1. Use [`docs/codebase-overview.md`](./codebase-overview.md) as the accurate description of the system.
2. Rewrite `CLAUDE.md` so every rule maps to code that exists. **Keep** the rules that are still
   true and valuable, updating their nouns:
   - Monorepo boundaries (§4) — still accurate; keep.
   - Multi-tenant isolation rules (§5) — still the core security control; keep, but the tenanted
     tables list must match `packages/db/src/tenanted-tables.ts` (Venue, Place, VisitorSession,
     Message, DataAdapter, OperationalUpdate, AnalyticsEvent, GuestSession→[removed in Item 7],
     DailyRollup, WeeklyDigest, TenantMembership, TenantFeatureFlag).
   - Auth/role rules (§6) — accurate; keep.
   - Data-access rules (§7), API/tRPC rules (§8) — keep; update the "base procedure" table to match
     the four real procedures.
   - Analytics rules (§10) — keep; update event names to the real allow-list in
     `packages/analytics/src/events.ts`.
   - Background-job rules (§12), logging/audit (§13), testing (§14), migrations (§17) — keep.
   - **Remove or mark as “not built”**: the integration framework section (§9), listing/booking
     domain language, S3/file-upload rules, impersonation rules (no such table), and any reference
     to `apps/admin` being deployed (note it’s built but deployment is in flux).
   - Replace the “Golden Path: add a new feature” example with one based on the real domain (e.g.
     “add a field to Place” or “add an analytics event”), matching the index in the overview doc §13.
3. In `docs/architecture.md`, add a banner at the very top:
   `> STATUS: Historical design intent (v1). The shipped product pivoted to an AI venue-guide
   > chatbot — see docs/codebase-overview.md and CLAUDE.md for the current system. Sections
   > describing listings/bookings/integration framework are NOT implemented.`

**Acceptance criteria:**

- `CLAUDE.md` contains no rule that references a non-existent table, package export, or file path.
- Every package/path named in `CLAUDE.md` exists in the repo.
- `architecture.md` has the status banner; its body is otherwise unchanged.
- No code changes in this commit.

---

## Item 2 — Stop committing build artifacts (`*.tsbuildinfo`)

**Why:** `apps/*/tsconfig.tsbuildinfo` and `packages/*/tsconfig.tsbuildinfo` are tracked in git, so
every commit shows them as modified and pollutes every diff.

**Steps:**

1. Add to `.gitignore`:
   ```
   # TypeScript incremental build info
   *.tsbuildinfo
   ```
2. Remove them from the index without deleting locally:
   ```bash
   git rm --cached **/*.tsbuildinfo
   ```
   (If the glob doesn’t expand in the shell, remove each tracked `tsconfig.tsbuildinfo` explicitly —
   there are 7: admin, dashboard, web, workers, analytics, api, db.)

**Acceptance criteria:**

- `git ls-files | grep tsbuildinfo` returns nothing.
- `.gitignore` ignores `*.tsbuildinfo`.
- `pnpm typecheck` still passes (regenerates them locally, now ignored).

---

## Item 3 — Fix the stale memory index

**Why:** `memory/MEMORY.md` points to files that don’t exist (`project_vision.md`, sprint summaries),
wasting context every session.

**Files:** `memory/MEMORY.md`

**Steps:**

1. List what actually exists in `memory/`: `MEMORY.md`, `project_state.md`, `user_profile.md`,
   `feedback_approach.md`.
2. Rewrite `MEMORY.md` so every bullet links only to a file that exists, with a one-line hook each.
   Remove the dead links. Do not invent new content.

**Acceptance criteria:**

- Every link in `MEMORY.md` resolves to a real file in `memory/`.
- No new memory files created.

---

## Item 4 — Move place embedding off the request path into a background job

**Why:** `embedPlace()` makes a synchronous OpenAI call inside tRPC mutations. `place.bulkCreate`
can fire up to **500 embedding calls in one request** — guaranteed to time out / rate-limit. The job
infra already exists; this is the obvious third job. This also resolves a stated `CLAUDE.md`
violation (no synchronous external API call in a web request).

**Files:**

- `packages/jobs/src/queues.ts` — add queue + job-name constants.
- `packages/jobs/src/types.ts` — add `EmbedPlaceJobPayload` (`{ placeId: string; tenantId: string }`).
- `packages/jobs/src/enqueue.ts` — add `enqueueEmbedPlace(payload)` with a deterministic
  `jobId: \`embed-place:${payload.placeId}\`` (so repeated edits dedupe), mirroring the existing
  enqueue helpers (attempts/backoff/removeOn\*).
- `apps/workers/src/processors/embed-place.ts` — new processor: load the place (use
  `withTenantIsolationBypass` + explicit tenant filter, like the other processors), rebuild the text
  via the existing `buildPlaceText` logic, generate the embedding, store it. **Move the embedding
  generation + `buildPlaceText` into a place the worker can import** without importing
  `packages/api` (workers must not depend on api). Recommended: relocate `buildPlaceText` +
  `generateEmbedding` + `storePlaceEmbedding` wiring into `packages/db` (which already owns
  `storePlaceEmbedding` and `semantic-search.ts`) **or** a small new helper the worker and api both
  import. Keep the OpenAI client a module-level singleton as it is now. Write a `JobRecord`
  (`writeJobRecord`/`updateJobRecord`) like the other processors.
- `apps/workers/src/index.ts` — register an `embed-place` queue + `Worker` with the same
  retry/backoff/shutdown pattern as the existing two queues. No cron scheduler (this queue is
  enqueue-driven, not scheduled).
- `packages/api/src/routers/place.ts` — replace the inline `await embedPlace(...)` /
  `await Promise.all(created.map(embedPlace))` calls in `create`, `update`, and `bulkCreate` with
  `enqueueEmbedPlace(...)` calls (fire-and-forget semantics preserved; never block the mutation).
- `packages/api/src/routers/venue.ts` — `updateAiConfig` has a re-embed-unembedded-places loop;
  replace its inline `embedPlace` calls with `enqueueEmbedPlace`.
- `packages/api/src/lib/embeddings.ts` — keep `generateEmbedding`/`buildPlaceText` exports if other
  code still imports them, but the `embedPlace` (generate-and-store-inline) function should no longer
  be called from request paths. You may keep it for tests or delete it if unused after the rewiring.

**Important constraints:**

- Workers must **not** import from `packages/api` (boundary rule). That’s why the shared embedding
  logic needs to live in `packages/db` or a neutral helper.
- If `REDIS_URL` is unset (local dev without Redis), enqueue should fail gracefully and not crash the
  mutation — wrap the enqueue in try/catch and log a warning, matching the fail-open spirit of the
  existing analytics emits. (A place simply stays unembedded until Redis is available; semantic
  search already falls back to geo/importance ordering.)

**Acceptance criteria:**

- No tRPC procedure awaits an OpenAI embedding call anymore.
- `place.create`, `place.update`, `place.bulkCreate`, `venue.updateAiConfig` enqueue embedding jobs.
- A new `embed-place` worker processes them, stores the vector, and writes a `JobRecord`.
- `apps/workers` does not import `@pathfinder/api`.
- Tests cover: enqueue is called on create/update; the processor stores an embedding (mock OpenAI).
- typecheck/lint/test clean.

---

## Item 5 — Resolve the empty stub packages

**Why:** `packages/integrations` (`export {}`) and `packages/ui` (`export {}`) are empty but are
treated as load-bearing by docs. Decide and act.

**Steps:**

1. **`packages/integrations`:** the integration framework is not part of the current product. Either:
   - **(preferred)** Delete the package entirely: remove `packages/integrations/`, remove it from
     `pnpm-workspace.yaml` if listed, remove any references, and remove the (unused) `DataAdapter`
     model + its relation on `Venue` in a new Prisma migration **only if** nothing references it
     (grep first). If `DataAdapter` removal is risky, leave the table and just delete the empty TS
     package — but note it in the PR.
   - If you’re unsure, do the minimal safe version: delete the empty package, keep `DataAdapter`,
     and note the table is unused.
2. **`packages/ui`:** this one we _want_ to keep and populate (Item 6 depends on it). Set it up as a
   real internal package: ensure `package.json` (`"private": true`, name `@pathfinder/ui`), a
   `tsconfig.json` extending the shared base, and `src/index.ts` ready to export shared components.
   Do not delete it.

**Acceptance criteria:**

- No empty `export {}`-only package remains that docs claim is meaningful.
- `packages/ui` is a buildable package ready to receive shared components.
- Workspace, typecheck, lint, test all clean.
- Any `DataAdapter`/migration decision is explained in the PR description.

---

## Item 6 — De-duplicate shared components into `packages/ui` (web + dashboard only)

**Why:** `PathFinderBrand.tsx` is copy-pasted across apps; `FadeIn.tsx` across web + dashboard; the
haversine formula is duplicated between `packages/api/src/lib/geo.ts` and
`packages/db/src/helpers/semantic-search.ts` (with an apologetic comment).

**Scope:** `apps/web` and `apps/dashboard` only. **Do not touch `apps/admin`** (boundary rule).

**Steps:**

1. Move genuinely shared, presentational components into `packages/ui/src` and export them:
   - `PathFinderBrand` / `PathFinderIcon` (reconcile the web vs dashboard variants into one
     component with props if they differ slightly).
   - `FadeIn`.
   - Only move components that are presentational and identical-or-trivially-parameterizable. Do
     **not** move app-specific components or anything that fetches data (per `packages/ui` rules).
2. Update `apps/web` and `apps/dashboard` imports to consume from `@pathfinder/ui`; delete the
   now-duplicated local copies in those two apps.
3. **Haversine dedup:** extract the haversine function into a single neutral location both
   `packages/api` and `packages/db` can import without creating a circular dependency. Since
   `packages/db` cannot import `packages/api`, put it in a low-level package both depend on —
   `packages/config` is the safe home (pure, no runtime deps), or a tiny new `packages/geo`. Update
   `geo.ts` and `semantic-search.ts` to import the single implementation and delete both inline copies
   and the apologetic comment.

**Acceptance criteria:**

- `PathFinderBrand` and `FadeIn` exist once in `packages/ui`, consumed by web + dashboard.
- Haversine exists exactly once; `geo.ts` and `semantic-search.ts` import it.
- `apps/admin` is untouched.
- typecheck/lint/test clean; both apps still build.

---

## Item 7 — Consolidate the dual session model (HIGHEST RISK — do last)

**Why:** Two tables model one concept. `VisitorSession` (chat messages, keyed by `anonymousToken`)
and `GuestSession` (counters, keyed by `sessionId` which _is_ the anonymous token) overlap, and the
analytics router hand-maintains `GuestSession.messageCount` separately from the actual `Message`
rows. Collapse to one.

**Decision:** keep **`VisitorSession`** as the single session table; remove `GuestSession`.

**Files:**

- `packages/db/prisma/schema.prisma` — remove the `GuestSession` model and its relations on
  `Tenant` and `Venue`. If you need the counters, add `messageCount Int @default(0)` and/or
  `lastSeenAt` to `VisitorSession` (it already has `lastActiveAt` and a `messages` relation — prefer
  reusing `lastActiveAt`; only add `messageCount` if a cheap counter is genuinely needed rather than
  `messages` count).
- New migration under `packages/db/prisma/migrations/` (follow the existing timestamped naming) that
  drops the `guest_sessions` table and adds any new `visitor_sessions` columns. Forward-only.
- `packages/db/src/tenanted-tables.ts` — remove `'GuestSession'`.
- `packages/api/src/routers/analytics.ts` — the `syncGuestSession` helper currently upserts/updates
  `GuestSession`. Repoint that bookkeeping onto `VisitorSession` (update `lastActiveAt`, and
  `messageCount` increment on `message.sent` if you added the column). The `trackEvent` mutation must
  keep recording per-session activity; it just writes to `VisitorSession` now. Note `VisitorSession`
  is keyed by `anonymousToken` (unique) while the analytics input passes `sessionId` (the same UUID)
  — upsert on `anonymousToken`.
- Any other reference to `guestSession`/`GuestSession` (grep the whole repo).

**Constraints / coordination:**

- The parallel admin work reads session activity from `VisitorSession`, `Message`, and `DailyRollup`
  — **not** `GuestSession`. Removing `GuestSession` is therefore safe for admin as long as
  `VisitorSession` remains the survivor. Do **not** rename `VisitorSession` or change its
  `anonymousToken` key.
- This is early-stage data; a data backfill from `guest_sessions` into `visitor_sessions` is
  **optional**. If you skip it, say so in the PR. If you do it, do it in the migration.

**Acceptance criteria:**

- `GuestSession` model, table, relations, and tenanted-tables entry are gone.
- `analytics.trackEvent` still records session activity (now on `VisitorSession`) and tests cover it.
- No remaining references to `GuestSession`/`guestSession` anywhere.
- Migration is forward-only and applies cleanly.
- typecheck/lint/test clean.

---

## Commit / PR structure

One commit per item, in order, each message prefixed:

- `docs: rewrite CLAUDE.md to match the shipped AI-guide product` (Item 1)
- `chore: stop tracking tsbuildinfo build artifacts` (Item 2)
- `docs: fix stale memory index` (Item 3)
- `feat(jobs): move place embedding to a background job` (Item 4)
- `chore: resolve empty stub packages` (Item 5)
- `refactor(ui): dedup shared components and haversine` (Item 6)
- `refactor(db): consolidate session model onto VisitorSession` (Item 7)

In the PR description, list any decisions you made under "if unsure" branches (DataAdapter removal,
backfill skipped, etc.) so they can be reviewed.
