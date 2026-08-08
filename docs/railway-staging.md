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

## Clerk webhook receipt canary

Migration `20260809020000_add_clerk_webhook_receipts` adds a platform-scoped receipt table plus
membership occurrence and welcome-completion fields. The receipt stores no raw payload, signature,
tenant ID, Clerk user ID, or email; its optional welcome pointer is an opaque internal membership
ID. The migration stamps every existing membership with its application-time millisecond cutoff;
pre-cutover deliveries are therefore stale by construction. Any later membership row missing a
cursor fails closed with a retryable dependency error instead of accepting an event as its baseline.
Deploy the dashboard schema and application from the same release SHA. Do not run a new
dashboard or worker replica against the old schema, and drain old replicas before accepting
evidence; mixed versions cannot prove the receipt or delivery boundary.

1. Using only the staging Clerk instance and synthetic identities, deliver one membership event
   and then replay the same signed delivery. Confirm one receipt, one membership transition, and
   one audit row. The replay must return 200 without another state or audit write.
2. Concurrently redeliver the same verified event ID and payload. Confirm exactly one caller owns
   the transition and all others resolve as exact replays. Then send two distinct event IDs for
   the same already-applied transition and confirm both receipts exist but only one audit row was
   needed.
3. Reuse a verified event ID with different content in a controlled synthetic request. Confirm a
   contained 200 acknowledgement, no membership mutation, one sanitized conflict signal, and no
   raw body, identity data, signature, or payload hash in application logs. Clerk retries every
   non-2xx response, so returning 409 here would create a futile retry loop.
4. Force an audit persistence failure in a disposable test, not in shared staging. Confirm the
   receipt, user, membership, and audit transaction all roll back and the same delivery succeeds
   cleanly after the failure is removed.
5. The welcome-email enqueue intentionally remains outside the database transaction. If enqueue
   fails after the receipt commits, the route returns 503 and an exact replay tries the same
   deterministic membership delivery again. The worker checks the durable membership completion
   timestamp before sending, persists a pre-provider attempt timestamp, and supplies a stable opaque
   provider idempotency key; after a provider success it persists completion before acknowledging
   the job. Resend retains idempotency keys for only
   [24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys), so automatic retries stop
   after a conservative 23-hour window when provider success is still ambiguous. Reconcile that
   delivery against the provider before any manual resend. Confirm enqueue failure recovery,
   immediate provider retry, the expired-attempt manual-reconciliation gate, and replay after BullMQ
   completion retention with an allow-listed test recipient. A member removed before delivery is
   durably cancelled and must not receive a later welcome if an old receipt is replayed.
6. Deliver a newer demotion followed by an older OWNER event with different provider IDs, then a
   newer removal followed by an older activation. Confirm the signed millisecond cursor stays at
   the newest event, the lower role/removal remains authoritative, and stale receipts create no
   membership or audit mutation. For equal timestamps, removal and the least-privileged role win.
7. Inspect a sample of pre-existing synthetic memberships and confirm they received a cutover
   cursor/baseline. Replay pre-cutover escalation and reactivation events; they must create only
   receipts and leave role/status/audit unchanged. Replay delayed pre-cutover demotion and removal;
   they must still reduce access while retaining the cutoff cursor. Confirm a membership created by
   the admin path also receives the database default baseline rather than a null cursor.

Rollback should retain the additive receipt table because it is the durable replay record. Stop
Clerk ingress, drain dashboard replicas, and prefer roll-forward. Reverting application code while
receipts exist reopens duplicate membership/audit behavior and removing the membership cursor can
reopen stale-event authorization regressions; dropping receipts or cursor/completion columns is not
an automatic rollback step.

## Durable generation dispatch canary

Answer-analysis and weekly-report requests now commit the domain row, request receipt, and audit
entry in one transaction. A dispatcher publishes the durable receipt to BullMQ, and the target
worker consumes the receipt only when it acquires the exact database execution claim. API kick
jobs are consumed on every worker deployment; `GENERATION_DISPATCH_ENABLED` controls only the
once-per-minute fallback scan that repairs a lost kick or an older `GENERATING` row with both
lease fields null.

Run this canary before generation recovery and only against independently verified staging
PostgreSQL and Redis resources:

1. Deploy the exact release SHA with `GENERATION_DISPATCH_ENABLED=false` and keep workers stopped
   until migration `20260809010000_add_generation_request_dispatches` is confirmed complete. The
   migration is additive and backfills eligible legacy null-lease rows; do not start an older
   worker against newly created receipts during the rollout.
2. Start every worker replica on the same SHA. Submit one synthetic answer-analysis request and
   one synthetic weekly-report request with opaque UUID request IDs. Confirm each API response is
   durable `PENDING` success, each receipt becomes `CONSUMED` only after the exact target job
   claims its row, and each target reaches its expected terminal state.
3. Replay both requests with the same UUID and identical normalized input. Confirm the original
   record IDs are returned and no second domain row, audit entry, provider call, or target job is
   created. Reuse one UUID with changed input and confirm a conflict with no writes.
4. In a controlled synthetic test, make the API kick enqueue unavailable while PostgreSQL remains
   available. Confirm the API still returns durable success and the receipt remains `PENDING`.
   Restore Redis, set `GENERATION_DISPATCH_ENABLED=true` uniformly, restart the worker replicas,
   and verify the fallback scheduler publishes and consumes that exact receipt.
5. Verify one synthetic legacy `GENERATING` row with null lease fields is adopted, dispatched, and
   consumed. Inspect sanitized dispatcher counts for adopted, leased, progressed, accepted,
   deferred, failed, and superseded work. Confirm request hashes, generated content, credentials,
   and raw dependency errors are absent from logs.
6. Observe at least two scheduler intervals and record pending count, oldest pending age, retry
   attempts, last safe error, target terminal outcomes, and exhausted BullMQ jobs. Persistent age
   growth, repeated failure-persistence errors, or any duplicate provider execution blocks
   promotion.

To stop fallback scanning, set `GENERATION_DISPATCH_ENABLED=false` on every worker replica and
restart them together, then verify the repeat scheduler was removed. Kick consumption remains
active so already committed API requests can still progress. Before reverting application code,
stop request ingress and workers, prove there are no `PENDING` receipts or active generation jobs,
and preserve audit evidence. Do not drop the additive table automatically: consumed receipts are
the idempotency record needed by clients retrying an uncertain response. Prefer roll-forward if
any receipt exists.

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

## Content-history migration canary

`20260809030000_add_content_versions` establishes immutable baselines and capture triggers for
venues, places, and knowledge entries. It takes `SHARE ROW EXCLUSIVE` locks on all three source
tables for the transaction so no write can land between a baseline scan and trigger installation.
Treat the lock window as a planned staging write drain, not as a zero-downtime assumption.

1. Before the migration, record exact row counts for `venues`, `places`, and
   `venue_knowledge_entries`, current long-running transactions, and the release SHA. Measure the
   migration on a disposable populated clone at representative row counts. Schedule a write drain
   if the measured lock duration exceeds the approved staging request budget.
2. Stop or drain dashboard/API writers and content-import jobs. Confirm no active transaction is
   writing the three source tables, then run `prisma migrate deploy` from the release artifact.
   Abort promotion if the migration waits unexpectedly or application write errors appear.
3. After commit, confirm exactly one `CREATE` baseline per pre-existing source row, all rows have
   `snapshot_schema_version = 1`, and the three capture triggers plus UPDATE/DELETE/TRUNCATE guard
   are installed. Counts must match the recorded preflight counts by entity type.
4. Using synthetic staging content, perform one create, content update, embedding-only update, and
   delete. Confirm the first three content changes produce actor-attributed versions in increasing
   sequence, the embedding-only update produces none, and the portal can restore the deletion.
5. Confirm cross-tenant history reads and reverts are denied, an attempted history-row mutation is
   rejected, and the migration is idempotent (`prisma migrate deploy` reports no pending work).

If the migration transaction fails, do not mark it applied manually: its explicit transaction must
leave no partial table, functions, triggers, or baselines. Diagnose and roll forward with a corrected
migration. After a successful migration, application rollback should retain `content_versions`, its
guards, and capture triggers; older application code does not depend on them, and dropping immutable
recovery evidence is destructive. Pause writers before rolling back application code. A destructive
down migration or history deletion requires a separately approved retention and incident decision.

## Operational-update lifecycle migration canary

`20260809040000_complete_operational_updates` adds explicit draft/published state, scheduling,
priority, update type, publication attribution, and immutable history to operational updates. It
write-locks `operational_updates` through backfill and trigger installation and takes an access-
exclusive lock on `content_versions` while expanding its entity constraint. Treat both as a
planned staging write drain.

1. Record the operational-update row count, active/unexpired count, content-version count, current
   long-running transactions, and release SHA. On a populated disposable clone, confirm every
   existing update backfills to `GENERAL_NOTICE`, `NORMAL`, `PUBLISHED`, `starts_at = created_at`,
   and matching publication attribution without changing prior guest visibility. The exact
   preflight `SELECT count(*) FROM operational_updates WHERE expires_at <= created_at;` must return
   zero; any nonzero result blocks migration for data review because the new time-window constraint
   will reject that legacy row. Also run
   `SELECT tenant_id, venue_id, count(*) FROM operational_updates WHERE is_active = true AND expires_at > CURRENT_TIMESTAMP GROUP BY tenant_id, venue_id HAVING count(*) > 20;`.
   It must return no rows. The migration enforces the same guard before its first schema mutation;
   review or deactivate obsolete notices before retrying rather than accepting silent guest-context
   truncation.
2. Drain operational-update writers and content-history reverts. Apply the migration from the
   release artifact. Abort promotion if either table lock waits beyond the measured staging budget
   or any writer remains active.
3. Confirm one `OPERATIONAL_UPDATE` baseline per pre-existing update, the dedicated capture trigger,
   publication/time-window constraints, and `operational_updates_guest_visibility_idx`. A second
   `prisma migrate deploy` must report no pending work.
4. Create a synthetic draft and confirm it is absent from the next guest-chat context. Publish it
   with a current start and future expiry and confirm it affects the very next chat request. Confirm
   a scheduled update is absent before its start, a deactivated update is absent immediately, and
   `expires_at` equal to the query timestamp is excluded. The API permits at most 20 overlapping
   published updates per venue and guest retrieval uses the same urgent-first deterministic cap;
   verify the 21st overlapping publish is rejected without hiding an accepted update.
5. Exercise a stale edit/publish token and cross-tenant identifiers; both must fail without a write
   or false audit. Restore the draft version through content history and confirm it becomes inactive
   and guest-invisible again.

If the migration fails, its explicit transaction must leave the new enums, columns, constraint
change, baseline rows, function, and trigger absent. Do not resolve or mark a failed migration
without inspecting that rollback evidence. After success, roll back application code only after
draining writers; retain the new columns and immutable versions. Reverting to code that treats all
rows as implicitly published would be unsafe, so a same-SHA forward fix is preferred. Dropping the
history trigger or rows requires separate retention and incident approval.

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
