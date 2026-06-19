# Implementation Packet — Analytics Rework (Guest Insights v2)

> **Paste this whole file into a fresh Claude Code / Codex session to execute the work.**
> Read [`docs/codebase-overview.md`](./codebase-overview.md) and `CLAUDE.md` first — they describe
> the real system (an AI venue-guide chatbot). This packet builds on that exact code.

---

## 0. Goal

Give venue operators real insight into how guests use the chat guide:

1. **Place interest** — which points of interest guests care about most.
2. **Topics** — the kinds of things guests ask about.
3. **Top questions** — the actual questions, grouped so near-duplicates collapse.
4. **Unique & returning visitors** — real visitor counts, not just sessions.
5. **Content gaps** — questions the venue's data could not confidently answer, captured **on the
   backend only** so operators know what content to add.

This is a substantial change across the schema, the chat hot path, the worker jobs, and the
dashboard. Do it as the ordered commits in §9. Keep every `CLAUDE.md` rule (tenant isolation, audit,
server-side analytics, routers live in `packages/api`, append-only event/audit tables).

---

## 1. Locked product decisions (do not re-litigate)

- **A1 — Place interest, NOT physical dwell time.** We do **not** add continuous GPS tracking.
  Interest is derived from existing signals: question/answer place mentions, `place_card.viewed`,
  `place_card.clicked`, `directions.opened`. (Real GPS dwell time was rejected: unreliable indoors,
  battery/privacy cost.)
- **B — Topics via a fixed taxonomy**, tagged by a cheap LLM call in a **nightly batch job** (never
  in the live chat path).
- **C — Top questions via semantic clustering**, computed nightly (embed questions, cluster,
  keep a representative phrasing + count per venue).
- **D — Persistent visitor identity.** Add a `visitorId` stored in the browser's **`localStorage`**
  (survives across visits), separate from the existing per-visit `anonymousToken` (sessionStorage).
  Unique visitors = distinct `visitorId`; returning = a `visitorId` seen on ≥2 distinct days.
- **E — Content-gap / low-confidence detection, BACKEND ONLY.**
  - **The chat must always project confidence. Do NOT add any "I'm not 100% sure" hedging to guest
    replies. No user-facing change to tone.** Keep the current "ground every answer in venue data,
    don't invent" behavior.
  - The low-confidence signal is **internal analytics only**, and **must not add live token cost.**
    See §6 for the zero-cost mechanism.

### The key insight for E (why it's cheap)

The chat pipeline **already computes a semantic similarity** for retrieval: `searchPlacesByEmbedding`
in `packages/db/src/helpers/semantic-search.ts` orders places by pgvector cosine distance
(`embedding <=> queryVector`). We **reuse that distance** as a free confidence proxy — if even the
best-matching place is semantically far from the question, the venue probably has no content for it.
**No extra model call, no confidence-scoring LLM pass in the hot path.**

---

## 2. Current state (what already exists — build on it, don't duplicate)

- **`AnalyticsEvent`** (append-only) already logs: `session.started`, `session.ended`,
  `message.sent` (metadata.message = the question text), `message.received`,
  `place_card.viewed`, `place_card.clicked`, `directions.opened`, `operational_update.viewed`,
  `venue.updated`. Keyed by `sessionId` (= the anonymousToken), `venueId`, optional `placeId`.
- **`VisitorSession`** = one chat visit (keyed by `anonymousToken`), has `latestLat/Lng`,
  `startedAt`, `lastActiveAt`, and `messages`.
- **`Message`** = role + content per turn.
- **`DailyRollup`** = pre-aggregated daily metrics. Columns: `tenantId`, `venueId`, `date`,
  `metric` (string), `placeId?`, `category?`, `value`. **Flexible — new metrics need no schema
  change.** Already produces `sessions`, `messages`, `place_mentions`, `unique_place_mentions`.
- **Workers** run `daily-rollup` (01:00 UTC) and `weekly-digest` (Sun 23:00 UTC) via BullMQ, each
  writing a `JobRecord`. Enqueue/queue plumbing is in `packages/jobs`.
- **Analytics router** (`packages/api/src/routers/analytics.ts`) already has `trackEvent` (public
  ingest), `getDailyStats`, `getTopQuestions` (exact-text grouping — to be upgraded), and digest
  reads.
- Embeddings: OpenAI `text-embedding-3-small` (1536-dim), wiring in `packages/db` (post-cleanup)
  and the chat retrieval. Reuse this for question clustering.

---

## 3. Data model changes (`packages/db`)

Add a migration under `packages/db/prisma/migrations/` (timestamped name, forward-only) plus the
matching `schema.prisma` edits.

1. **`VisitorSession`** — add persistent visitor id:
   - `visitorId String? @map("visitor_id")` + `@@index([visitorId])`.
2. **`Message`** — add nightly-filled topic label:
   - `topic String? @map("topic")`. (Nullable; the batch job fills it. Optional index
     `@@index([topic])` if you add topic-filtered queries.)
3. **New table `QuestionCluster`** (tenanted) — stores both top-question clusters and content-gap
   clusters per venue/window:
   ```
   model QuestionCluster {
     id            String   @id @default(cuid())
     tenantId      String   @map("tenant_id")
     venueId       String   @map("venue_id")
     kind          String   // 'top_question' | 'content_gap'
     windowStart   DateTime @map("window_start")
     windowEnd     DateTime @map("window_end")
     canonicalText String   @map("canonical_text")   // representative phrasing
     count         Int
     examples      Json     @default("[]")           // a few example raw questions
     createdAt     DateTime @default(now()) @map("created_at")
     tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)
     venue  Venue  @relation(fields: [venueId], references: [id], onDelete: Restrict)
     @@index([tenantId, venueId, kind, windowStart])
     @@map("question_clusters")
   }
   ```

   - Add the back-relations on `Tenant` and `Venue`.
   - **Add `'QuestionCluster'` to `packages/db/src/tenanted-tables.ts`** (TENANTED_TABLES) so the
     isolation middleware protects it. This is mandatory per CLAUDE.md §17.
4. **`DailyRollup`** — no schema change. New metric strings the rollup/enrichment jobs will write:
   - `place_card_views`, `place_card_clicks`, `place_directions` (per `placeId`),
   - `topic` with `category = <topicKey>` (per venue),
   - `unique_visitors` (per venue/day),
   - `low_confidence` (count per venue/day).

---

## 4. Visitor identity (decision D) — client + chat wiring

- **`apps/web`:** add a `useVisitorId` hook (mirror `useSession`) that reads/creates a UUID in
  `localStorage` under `pathfinder_visitor_id` and returns it. Pass `visitorId` into:
  `chat.session`, `chat.send`, and `analytics.trackEvent` calls in
  `apps/web/app/[venueSlug]/chat/page.tsx`.
- **`packages/api`:** add an optional `visitorId: z.string().uuid().optional()` to the `chat.session`,
  `chat.send`, and `analytics.trackEvent` input schemas. On the `VisitorSession` upsert in
  `chat.session`/`chat.send`, set `visitorId` when provided (create + update). Keep it optional so
  older clients still work.
- **Unique/returning visitor reads** are derived from `VisitorSession.visitorId`:
  - unique visitors in window = `COUNT(DISTINCT visitorId)` among sessions started in the window,
  - returning = a `visitorId` with sessions on ≥2 distinct UTC days.
    The daily rollup can store `unique_visitors` per day; "returning" is computed in the read query
    (cross-day) — see §7.

---

## 5. Place interest (decision A1)

No new tracking. In the nightly job (or extend `daily-rollup`), aggregate per `placeId` for the day:

- count of `place_card.viewed`, `place_card.clicked`, `directions.opened` from `AnalyticsEvent`,
- reuse the existing `place_mentions` rollup.
  Write them as `DailyRollup` metrics (`place_card_views`, `place_card_clicks`, `place_directions`).
  The dashboard computes an **interest score** as a weighted sum (propose: mentions×1 + views×1 +
  clicks×2 + directions×3) — keep the weights in one constant so they're easy to tune.

---

## 6. Content-gap / low-confidence detection (decision E) — ZERO live token cost

### 6a. Live signal (in `packages/api/src/routers/chat.ts`, no extra model call)

1. Make `searchPlacesByEmbedding` (in `packages/db/src/helpers/semantic-search.ts`) **also return
   the cosine distance** of each row: add `embedding <=> ${vectorStr}::vector AS distance` to the
   SELECT and include `distance` on the returned objects. (It currently orders by it but discards it.)
2. In `chat.send`, after retrieval, compute a low-confidence flag **without any new API call**:
   - If semantic search ran: `topDistance = relevantPlaces[0]?.distance`. Flag if `topDistance` is
     `null`/`undefined` or `> LOW_CONFIDENCE_DISTANCE_THRESHOLD`.
   - If the **geo/importance fallback** ran (no embedding available, so no semantic score): fall back
     to a cheap **response heuristic** — flag if the assistant reply matches a small set of
     "no-info" patterns (e.g. /I don't have|I'm not sure|check with (staff|the front desk)|couldn't
     find/i). Zero tokens.
   - `LOW_CONFIDENCE_DISTANCE_THRESHOLD` is a tunable constant (start ~`0.55` cosine distance, i.e.
     similarity < ~0.45 for normalized OpenAI embeddings). **Comment that it needs tuning on real
     data.**
3. When flagged, emit a new analytics event (best-effort, wrapped in try/catch like the existing
   emits — must never break the chat):
   - Add `'message.low_confidence'` to `packages/analytics/src/events.ts` allow-list.
   - `emitEvent({ ..., eventType: 'message.low_confidence', metadata: { question, score: topDistance ?? null } })`.

**Do not change the guest-facing reply or tone.** The flag is invisible to the visitor.

### 6b. Nightly aggregation (content gaps)

In the enrichment job (§7), cluster the flagged `message.low_confidence` questions (same clustering
as top-questions) and store them as `QuestionCluster` rows with `kind = 'content_gap'`. This is what
the dashboard surfaces as "content gaps."

### 6c. Optional bounded refinement

If you want higher-quality gap labels, a cheap Haiku pass may run **only over the flagged questions**
(not every message) to confirm/categorize them. This keeps token cost bounded to the gap subset.
Mark it optional/behind a constant; default off if you want to ship cheap first.

---

## 7. Nightly enrichment job (`packages/jobs` + `apps/workers`)

Add a **new queue** `analytics-enrichment` (don't overload `daily-rollup`, which is pure SQL).
Schedule it nightly **after** the rollup (e.g. `30 1 * * *`). Mirror the existing queue/worker
patterns in `apps/workers/src/index.ts` and `packages/jobs` (queue constants, typed `enqueue`,
retry/backoff, `JobRecord` per run, graceful shutdown). One process job per active tenant.

For each tenant/venue, the processor does:

1. **Topic tagging (B):** fetch the day's `Message` rows (role `user`) with `topic IS NULL`;
   classify in **batches** (e.g. 20 questions per Haiku call) into the fixed taxonomy (§8); write
   `Message.topic`. Then roll up topic counts → `DailyRollup` (`metric='topic'`, `category=topicKey`).
2. **Top-question clusters (C):** over a rolling window (start with 30 days) of user questions,
   embed them (`text-embedding-3-small`, batched, cheap), greedily cluster by cosine similarity
   threshold, pick a representative phrasing per cluster, and **replace** that venue's
   `kind='top_question'` rows for the window with the top N clusters.
3. **Content gaps (E):** same clustering over `message.low_confidence` questions →
   `kind='content_gap'` rows. (Optional §6c refinement here.)
4. **Place interest (A1):** aggregate `place_card.*` / `directions.opened` per place → `DailyRollup`
   metrics.
5. **Unique visitors (D):** count distinct `visitorId` among sessions started that day →
   `DailyRollup` `unique_visitors`.

**Cost control (state it in code comments):** all LLM/embedding work is nightly, batched, on Haiku +
cheap embeddings, and gap refinement is bounded to flagged questions only. The live chat path gains
**no** new model calls.

Use `withTenantIsolationBypass` in the processor exactly as the existing processors do.

---

## 8. Proposed fixed topic taxonomy (editable)

Single-label per question (pick the best fit; `other` when nothing fits):

`directions_navigation`, `amenities_restrooms`, `food_drink`, `hours_logistics`,
`tickets_pricing`, `accessibility`, `history_meaning`, `recommendations`, `events_today`, `other`.

Keep this list in **one constant** (e.g. `packages/analytics` or a shared config) so it's the single
source of truth for the classifier prompt and the dashboard labels.

---

## 9. Dashboard surfacing (`packages/api` reads + `apps/dashboard`)

Add `tenantProcedure` queries to the analytics router (reuse for the in-dashboard admin console's
`getClient`/`getClientVenue` where useful):

- `getVisitorStats({ days })` — unique visitors, returning visitors, total sessions over the window.
- `getTopTopics({ days })` — from `DailyRollup` `metric='topic'`.
- `getTopQuestions({ days })` — now reads `QuestionCluster` `kind='top_question'` (replaces the
  current exact-match implementation; keep the same procedure name/shape if possible).
- `getContentGaps({ days })` — `QuestionCluster` `kind='content_gap'`. **This is the headline new
  operator value — make it prominent.**
- `getPlaceInterest({ venueId, days })` — ranked places from the interest metrics + weights.

Then add widgets to `apps/dashboard/app/(app)/analytics/page.tsx` (and optionally the admin
`getClientVenue` detail): visitors, top topics, top questions, **content gaps**, place-interest
ranking. Optionally fold the new signals into the weekly AI digest prompt.

Keep all reads off OLTP aggregates per CLAUDE.md — read from `DailyRollup` / `QuestionCluster` /
`AnalyticsEvent`, not by aggregating `messages` live in the dashboard.

---

## 10. Guardrails / constraints

- **Tenant isolation:** `QuestionCluster` is tenanted → in `tenanted-tables.ts`; every query carries
  `tenantId`; the enrichment/admin cross-tenant reads use `withTenantIsolationBypass`.
- **Analytics is server-side & best-effort:** new emits wrapped in try/catch; never break the chat
  or a job. `AnalyticsEvent` stays append-only.
- **No new live model calls.** Live chat cost must be unchanged. All LLM/embedding work is nightly,
  batched, bounded.
- **No guest-facing tone change.** Chat always projects confidence; the low-confidence flag is
  internal only.
- **Tunables in named constants:** `LOW_CONFIDENCE_DISTANCE_THRESHOLD`, clustering similarity
  threshold, place-interest weights, topic taxonomy, top-N. Comment that thresholds need real-data
  tuning.
- **Privacy:** verbatim questions are already stored; no new PII. Don't log question text at
  `warn`+ levels.

---

## 11. Suggested commit order

1. `feat(db): visitorId, message topic, QuestionCluster + migration` (schema + tenanted-tables).
2. `feat(web): persistent visitorId and chat wiring` (decision D, client + chat schemas).
3. `feat(api): backend low-confidence flag from retrieval distance` (decision E live + event type +
   semantic-search distance).
4. `feat(jobs): nightly analytics-enrichment job` (topics, clusters, gaps, place-interest, unique
   visitors).
5. `feat(dashboard): visitor/topic/question/content-gap/place-interest widgets` (reads + UI).
6. `test: analytics rework coverage`.

---

## 12. Verification

After each commit, from repo root: `pnpm install` (if deps changed) then `pnpm typecheck`,
`pnpm lint`, `pnpm test` — all clean. Confirm the migration applies. Add tests for: the
low-confidence flag thresholding, the enrichment processor (mock OpenAI/Haiku), the new tRPC reads
(success + FORBIDDEN paths), and visitorId wiring. Per CLAUDE.md, every new tRPC procedure needs a
FORBIDDEN-path test.

---

## 13. Open knobs to confirm with the founder before/while building

- Topic taxonomy list (§8) — accept as-is or edit.
- `LOW_CONFIDENCE_DISTANCE_THRESHOLD` and clustering threshold starting values — fine to ship with
  the defaults above and tune after seeing real data.
- Whether to enable the optional §6c gap-refinement LLM pass now or later.
- Rolling window lengths (default: 30d for clusters, per-day for rollups).
