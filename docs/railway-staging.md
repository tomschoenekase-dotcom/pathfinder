# Railway staging configuration

This runbook creates a staging release boundary for PathFinder. It does not
authorize access to an account, provision resources, change credentials, or
deploy anything by itself.

> **An environment name is not isolation.** A Railway environment named
> `staging` and `RAILWAY_ENVIRONMENT=staging` are labels and application-level
> guards. They do not prove that the database, Redis, storage, Clerk tenant, or
> outbound services are separate from production. Verify the identity and
> permissions of every backing resource before running a migration or seed.

## Required staging topology

Create three services from the repository root:

| Service    | Railway config                   | Runtime                                              |
| ---------- | -------------------------------- | ---------------------------------------------------- |
| Public web | `railway.staging.web.json`       | `Dockerfile.web`; HTTP health check at `/api/health` |
| Dashboard  | `railway.staging.dashboard.json` | root `Dockerfile`; standalone dashboard server       |
| Workers    | `railway.staging.workers.json`   | `Dockerfile.workers`; no HTTP listener               |

All three services must deploy the exact same Git commit SHA. Set
`RAILWAY_ENVIRONMENT=staging` on every service. Do not use a branch name or a
successful build time as proof that the revisions match; record the full SHA
reported for each deployment.

Before adding application variables, provision resources that are physically
or logically independent from production:

- A separate staging Supabase project or PostgreSQL instance. Both
  `DATABASE_URL` and `DIRECT_DATABASE_URL` must resolve to staging. Record and
  compare their host/project identity with production; it must differ.
- A separate Redis instance and `REDIS_URL`. Confirm its host/database identity
  differs from production and that deleting staging keys cannot affect live
  queues.
- A separate storage project/bucket plus staging-scoped access keys. Its policy
  must not allow writes to a production bucket or namespace.
- Clerk development/test keys, a staging webhook endpoint and secret, and only
  staging callback/redirect URLs. Never copy production Clerk secret keys or a
  production webhook secret into staging.
- Test-safe outbound credentials. Use provider sandbox/test modes, restricted
  API keys, staging webhook destinations, spend limits, and allow-listed test
  recipients where supported. Staging must not send customer email, mutate a
  live integration, or share a production signing/encryption secret.

Give the least privilege needed to each service. The dashboard and web services
normally do not need every worker-only outbound credential.

## Release procedure

Local destructive migration proofs must use the disposable-only wrapper, never the raw
`db:migrate` or `db:migrate:prod` scripts. The wrapper accepts only an explicitly named
`pathfinder_disposable_*` database on exact loopback, removes inherited Prisma and Node target
overrides, and forces `DATABASE_URL` and `DIRECT_DATABASE_URL` to the same validated URL. Put the
URL only in the purpose-specific environment variable, populated through a local secret-safe
environment mechanism; never pass the URL as a CLI argument. The placeholders below are not
literal credentials:

```bash
PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS=1 \
PATHFINDER_DISPOSABLE_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/pathfinder_disposable_example' \
pnpm db:migrate:disposable -- \
  --database pathfinder_disposable_example \
  --confirm-database pathfinder_disposable_example
```

PowerShell uses the same contract:

```powershell
$env:PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS = '1'
$env:PATHFINDER_DISPOSABLE_DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:PORT/pathfinder_disposable_example'
pnpm db:migrate:disposable -- `
  --database pathfinder_disposable_example `
  --confirm-database pathfinder_disposable_example
```

Loopback coordinates do not prove server identity if a developer has deliberately installed a
local tunnel or proxy. For evidence-grade proofs, create an exact-name disposable container on a
dedicated port, verify `current_database()` and the finished migration count, then remove that
exact container.

The raw production migration command below remains reserved for an independently confirmed
staging release shell. The disposable wrapper intentionally has no external-host escape hatch.

1. Select a release commit and record its full SHA as `RELEASE_SHA` in the
   release evidence. Confirm the repository tests required for that commit have
   passed.
2. Configure the three staging services to deploy `RELEASE_SHA`. Before
   starting workers, compare each service's displayed source revision with the
   recorded SHA.
3. From a one-off shell or checkout pinned to `RELEASE_SHA`, print or inspect
   the non-secret database host/project identity. Stop if it has not been
   independently confirmed as staging.
4. Apply forward migrations to the staging database before inserting synthetic
   data:

   ```bash
   pnpm --filter @pathfinder/db db:migrate:prod
   ```

   Capture the command result and the migration status. A failed or partially
   applied migration blocks the release.

5. Only after migrations succeed, run the idempotent synthetic seed against the
   same verified staging database:

   ```bash
   pnpm --filter @pathfinder/db db:seed
   ```

   The seed also checks `RAILWAY_ENVIRONMENT=staging`, but that check is not a
   substitute for verifying the database endpoint.

6. Deploy web, dashboard, and workers from `RELEASE_SHA`. Keep workers stopped
   until migrations are complete. Record the resulting Railway deployment ID
   and full source SHA for each service.
7. Start the workers with `EMBEDDING_DISPATCH_ENABLED=false`. Confirm the new
   `EmbeddingDispatch` table and content triggers exist, then make one synthetic
   place or knowledge edit and verify a single coalesced dispatch row is committed.
   Only after that proof, set `EMBEDDING_DISPATCH_ENABLED=true` and restart the
   staging worker. This flag is independent of `WORKER_SCHEDULERS_ENABLED`.
8. Run the smoke tests below. Any failure blocks production promotion; fix it
   in a new commit and repeat the entire exact-SHA procedure.

## Generation recovery canary

Generation recovery is a separate, default-off safety mechanism for answer-analysis and weekly-
report rows left in `GENERATING` after a worker dies. Each minute it inspects at most 50 expired
rows of each type, oldest lease first, and submits recovery requests that can acquire only the
exact expired lease token they observed. A delayed request for an older token cannot acquire a
newer generation. Recovery does not repair rows whose lease token or expiry is null.

Run this canary only against independently verified staging PostgreSQL and Redis resources:

1. Deploy the exact release SHA with `GENERATION_RECOVERY_ENABLED=false` on every worker replica.
   Apply migrations first. Confirm ordinary analysis and report jobs still complete.
2. This release changes every non-production BullMQ queue prefix from `staging:` / `preview:` to
   `staging--` / `preview--` because BullMQ forbids `:` in queue names. Before enabling workers,
   inspect staging Redis for legacy-prefixed waiting, delayed, active, or failed jobs. Record and
   deliberately drain or remove only those staging jobs under the normal data-retention policy;
   never perform a broad Redis key deletion. Production queue names are unchanged.
3. Create synthetic staging-only analysis and weekly-report rows with valid tenant, venue, and
   range identities. Include one expired lease, one active lease, and one expired token A that is
   superseded by token B before its recovery request executes. Do not alter real customer rows.
4. Set `GENERATION_RECOVERY_ENABLED=true` uniformly on all worker replicas and perform a
   coordinated restart. Mixed flag values make scheduler ownership and operator evidence
   ambiguous. Verify exactly one repeating `generation-recovery-scheduler` definition with the
   one-minute cron and no startup cleanup errors.
5. Verify the expired rows each reach one terminal outcome and at most one provider execution.
   The active row must not run. The delayed token-A request must complete as an ineligible no-op
   after token B replaces it. Confirm recovery `JobRecord` payloads contain no lease token and
   logs contain only sanitized IDs/counts, never generated content or credentials.
6. Observe at least two scheduler intervals. Record discovered, accepted enqueue-request, and
   failure counts; oldest expired lease age; remaining expired backlog by type; provider retry or
   exhaustion events; and distinct recovery-job failures. A backlog that stays above 50 per type,
   increasing oldest age, enqueue failures, or exhausted jobs blocks promotion because the
   oldest-first bounded scan can starve newer rows.

Rollback is operationally reversible: set `GENERATION_RECOVERY_ENABLED=false` on every worker
replica and restart them together, then verify the scheduler definition was removed. Disabling
the flag does **not** cancel recovery jobs already waiting or delayed. Inspect the dedicated
answer-analysis and weekly-report recovery job names and let safe exact-token no-ops finish, or
drain only those staging recovery jobs under an approved incident procedure. Do not delete
ordinary generation jobs or broad queue namespaces. Preserve failed-job and `JobRecord` evidence
before any drain.

## Staging smoke tests

- Request the public web `/api/health` endpoint and record the status code and
  response. Railway health must be green.
- Open the seeded venue in the public web app and complete one cheap guest chat
  turn. Confirm a persisted visitor/message flow and no production venue data.
- Sign in to the dashboard with a Clerk test user, select the staging tenant,
  and verify one read plus one reversible write. Confirm the change exists only
  in staging.
- Edit one synthetic place or knowledge record and confirm its outbox row is
  dispatched, the matching embedding `JobRecord` reaches the expected terminal
  state, and no production Redis queue or outbound destination is touched. Repeat
  the same content revision and confirm the provider-work claim avoids a second
  provider call. Preserve only sanitized IDs and counts as evidence.
- Exercise any storage or outbound integration changed by the release using a
  disposable object/test recipient, then remove or expire that test artifact.
- Review service logs for startup, migration, tenant-isolation, queue, and
  credential errors. Logs must not contain secrets or private payloads.

## Manual production promotion

Production promotion is an explicit manual approval, not an automatic effect
of a staging deployment. Promote only the exact `RELEASE_SHA` that passed every
staging smoke test. Re-check that production uses production resources and
`RAILWAY_ENVIRONMENT=production`; never seed production. Apply production
migrations using the approved migration/recovery procedure, then deploy web,
dashboard, and workers from that same SHA. If any code changes after staging
approval, it is a new release and must return to staging.

## Required proof

Attach or link the following to the release record without exposing secrets:

- Full `RELEASE_SHA`, test results, approver, and approval timestamp.
- Staging resource inventory showing distinct database/Supabase project,
  Redis instance, storage bucket/project, Clerk instance, and outbound provider
  mode. Use masked IDs/hosts and permission summaries, never secret values.
- Migration status and seed output tied to the verified staging database.
- Railway deployment IDs and full source SHAs for web, dashboard, and workers.
- Smoke-test timestamps, URLs, expected/actual results, relevant job or request
  IDs, and sanitized screenshots/log excerpts.
- The production deployment IDs and full source SHAs proving that the manually
  promoted release matches the staging-approved commit.

Missing evidence means the isolation or release state is unverified and blocks
promotion.
