---
name: Project State
description: Current deployment status of PathFinderOS — what's live, what's pending, known issues
type: project
---

## Railway Services (as of 2026-04-14)

| Service                    | What it is                       | URL                                               |
| -------------------------- | -------------------------------- | ------------------------------------------------- |
| pathfinder-production-fcdd | Dashboard (tenant staff + admin) | https://pathfinder-production-fcdd.up.railway.app |
| sweet luck                 | Guest-facing web app (apps/web)  | Railway-assigned URL, check Railway               |
| workers service            | BullMQ workers (no public URL)   | Background process only                           |
| Redis                      | Redis instance for BullMQ        | Internal to Railway                               |

**Why:** Dashboard and web app are separate Next.js deployments. Workers runs as a background process.
**How to apply:** When Tom asks about URLs or deployment, refer to this table.

## What's fully working

- Tenant signup via Clerk webhook → auto-creates Tenant row
- Dashboard: venue/place management, operational updates, analytics page, clients page
- Guest chat: AI-powered via Claude Sonnet, served from apps/web at /{venueSlug}/chat
- Weekly digest worker: runs every Sunday 23:00 UTC, calls Claude Sonnet, writes WeeklyDigest
- Daily rollup worker: runs every night 01:00 UTC, populates DailyRollup table
- JobRecord table: every worker run logged to job_records in Supabase
- Admin features: listClients, createClient, updateClientStatus, triggerDigest (all in dashboard /clients)

## Known pending items

- Test the Clerk webhook end-to-end: create a new Clerk org and confirm Tenant row appears in Supabase automatically. The 307 redirect issue was fixed (webhook route added to PUBLIC_ROUTES in middleware) but hasn't been confirmed working in production.
- apps/admin (separate admin console) has NOT been deployed. Tom is using /clients in the dashboard instead for now.
- Tom's platform admin access: set `{ "platform_role": "PLATFORM_ADMIN" }` in Clerk Dashboard → Users → Tom's user → Public Metadata to see the Clients page in the dashboard sidebar.

## Database

- Supabase (PostgreSQL)
- DATABASE_URL must be the session pooler URL (aws-1-us-east-2.pooler.supabase.com) — NOT the direct URL
- DIRECT_DATABASE_URL stays as the direct connection (used for migrations only)
- Pending migrations have been applied: weekly_digests and job_records tables exist in Supabase

## Test venue

- Slug: forest-hall-test-one
- Guest chat URL: {web-app-url}/forest-hall-test-one/chat
- Tenant org in Clerk: org_3CHKO7cpBBg553evaUnQZgCSVwN

## Key env vars needed per service

- Dashboard: DATABASE_URL (pooler), DIRECT_DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_WEBHOOK_SECRET, ANTHROPIC_API_KEY, REDIS_URL
- Web app: DATABASE_URL (pooler), DIRECT_DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, ANTHROPIC_API_KEY
- Workers: DATABASE_URL (pooler), DIRECT_DATABASE_URL, CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY, REDIS_URL, ANTHROPIC_API_KEY
