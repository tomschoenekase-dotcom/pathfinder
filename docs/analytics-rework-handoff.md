# Analytics Rework — Handoff

> Status as of 2026-06-23. Implements `docs/analytics-rework-packet.md`.
> Branch `feat/analytics-rework` is pushed to origin but **NOT merged** to `master`.

## TL;DR

The full analytics rework from the packet is built, tested, and pushed on branch
`feat/analytics-rework` (9 commits). `pnpm typecheck`, `pnpm lint`, `pnpm test` are all green,
and the dashboard production build passes locally. **It is not merged and not live.** Two things
must happen before/at merge: (1) open + merge the PR, (2) apply the DB migration to Supabase
(Railway does NOT do this automatically).

## What was built (commits on the branch)

1. `feat(db)` — `VisitorSession.visitorId`, `Message.topic`, new tenanted `QuestionCluster` table,
   migration `packages/db/prisma/migrations/20260619010000_analytics_rework`, added `QuestionCluster`
   to `TENANTED_TABLES`.
2. `feat(web)` — `apps/web/hooks/useVisitorId.ts` (localStorage UUID), threaded optionally through
   `chat.session`, `chat.send`, `analytics.trackEvent`; set on the `VisitorSession` upserts.
3. `feat(api)` — backend-only low-confidence flag. `searchPlacesByEmbedding` now returns pgvector
   cosine `distance`; `chat.send` emits a new internal-only `message.low_confidence` event when
   retrieval is weak. No guest-facing/tone change, no extra model call.
4. `feat(jobs)` — new `analytics-enrichment` BullMQ queue (cron `30 1 * * *`, after the daily rollup)
   - per-tenant processor in `apps/workers/src/processors/analytics-enrichment.ts`: Haiku topic
     tagging, greedy-cosine question clustering (top_question + content_gap), place-interest /
     unique-visitor / low-confidence `DailyRollup` metrics. Deletes only the metrics it owns so it
     never clobbers the SQL daily-rollup job.
5. `feat(dashboard)` — new analytics reads (`getVisitorStats`, `getTopTopics`, `getContentGaps`,
   `getPlaceInterest`) + reworked `getTopQuestions` (now reads `QuestionCluster`), and widgets on
   `apps/dashboard/app/(app)/analytics/page.tsx` (visitor stats + content gaps up top).
6. `test` — low-confidence thresholding, enrichment processor + `clusterQuestions`, all new tRPC
   reads incl. FORBIDDEN paths, visitorId wiring. Plus a `test(db)` fix updating the
   tenanted-tables list assertion.
7. Two housekeeping commits: the packet doc, and pre-existing local settings + marketing brief.

## Outstanding work for the next session

1. **Open + review + merge the PR** for `feat/analytics-rework`:
   https://github.com/tomschoenekase-dotcom/pathfinder/pull/new/feat/analytics-rework
2. **Apply the DB migration** ⚠️ REQUIRED, and NOT automatic. The running code expects the new
   columns/table. Railway runs `prisma generate` (client codegen only) on deploy but **no config
   runs `prisma migrate deploy`** — migrations have always been applied manually here. Run once
   against Supabase: `pnpm --filter @pathfinder/db db:migrate:prod` (uses `DIRECT_DATABASE_URL`).
   Migration only ADDS columns/a table — safe, non-destructive. Do it before the merged code serves
   traffic, or `chat.send` and the dashboard reads will error on missing columns. Consider adding
   `migrate deploy` to the deploy pipeline so it's automatic going forward.
3. **Tune thresholds on real data** (all named constants, flagged in code): `LOW_CONFIDENCE_DISTANCE_THRESHOLD`
   (0.55, in `packages/api/src/routers/chat.ts`), `CLUSTER_SIMILARITY_THRESHOLD` (0.83) and other
   knobs in the enrichment processor, `PLACE_INTEREST_WEIGHTS` (mentions×1, views×1, clicks×2,
   directions×3, in `analytics.ts`).
4. **Expect blank widgets at first.** Content gaps/topics/clusters stay empty until the nightly
   enrichment job has run on real guest questions, and visitor stats need traffic carrying the new
   `visitorId`.
5. **Optional, deferred:** §6c Haiku gap-refinement pass (left off), and folding the new signals
   into the weekly-digest prompt (§9, left out).

## Deploy / infra facts learned this session

- **Railway ↔ GitHub auto-deploy is ON.** Pushing to the deployed branch (`master`) triggers a
  Railway build automatically. The feature branch is not deployed.
- **Services:** `dashboard`, `web`, `workers`, `redis`. Build configs in repo
  (`railway.json`, `apps/dashboard/railway.json`, `nixpacks.toml`, `Dockerfile`) all build/run the
  dashboard; the other services are configured in the Railway UI.
- **Workers fail-fast env:** `apps/workers/src/index.ts` asserts `REDIS_URL`, `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY` at startup and exits if any is missing.
- **Resolved this session:** the workers service was crash-looping with
  `Missing required environment variable(s) for workers: OPENAI_API_KEY`. Cause: the earlier
  "worker env fail-fast" commit on `master` (not the analytics branch) plus the workers Railway
  service missing that var. Fix applied by the user: added `OPENAI_API_KEY` to the workers service
  Variables in Railway. (The enrichment job needs this key anyway for embeddings.)

## Verification reference

From repo root: `pnpm install` → `pnpm typecheck` → `pnpm lint` → `pnpm test` (all clean).
Dashboard build: `pnpm --filter @pathfinder/dashboard build` (passes; `/analytics` is dynamic).
Migration apply is the one step not verifiable without a database.
