# Railway staging configuration

> **Migration instruction status: STAGING-ONLY AUTHORIZED — PRODUCTION COMMANDS REMAIN STOPPED.**
> Tom approved this isolated Railway staging release on 2026-08-19 with a hard USD 10 ceiling. The
> production stop in [`database-incident-stop.md`](database-incident-stop.md) remains binding.

For the active day-to-day feature and promotion path, see
[`staging-release-workflow.md`](staging-release-workflow.md).

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

### Configuration ownership

The three `railway.staging.*.json` files above are the only checked-in configuration-as-code
inputs for the proven staging application services. The staging verifier does not accept a root or
app-scoped fallback.

The following files remain compatibility inputs for the separately managed production/legacy
topology and are **not staging configuration**:

- `railway.json`, `apps/dashboard/railway.json`, and `nixpacks.toml` for dashboard compatibility;
- `railway.web.json` for the non-staging public-web service; and
- `railway.workers.json` for the non-staging worker service.

Exact staging proof does not prove whether a production service or recovery workflow still consumes
one of those compatibility files. Do not delete, repoint, or silently reuse them for staging until
the owner records the live service config path through a separately authorized production inventory.
Production remains untouched.

All three services must deploy the exact same Git commit SHA. Set
`RAILWAY_ENVIRONMENT=staging` on every service. Do not use a branch name or a
successful build time as proof that the revisions match; record the full SHA
reported for each deployment.

Every service resolves the reported revision through one strict shared contract. Provider-injected
`RAILWAY_GIT_COMMIT_SHA` remains authoritative. For an explicitly reviewed Railway local-upload
release where provider Git metadata is absent, set `PATHFINDER_RELEASE_SHA` to the exact lowercase
40-character commit on every service. Missing, malformed, or conflicting provider/configured
revisions report `unknown` and fail exact-SHA admission; never use a branch name or abbreviated SHA.

The staging-only exception requires resources that are physically or logically independent from
production before adding application variables:

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

### Dormant worker admission

Start a newly provisioned staging worker with `OUTBOUND_PROVIDER_WORKERS_ENABLED=false` and every
other worker execution flag set to `false`. In this mode the process requires only `REDIS_URL`,
pings Redis, and remains connectivity-only: its bootstrap does not import the provider-enabled
application graph, it creates no BullMQ queues, consumers, or schedulers, and it requires no
database, Clerk, Anthropic, or OpenAI variable. A subordinate execution flag set to `true` while
this mode is disabled is a startup error.

Authoritative intake-upload verification is an internal worker and does not require outbound AI or
email provider authority. Enable it explicitly with
`INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED=true`. Its startup then fails closed unless Redis,
database, quarantined object-storage credentials, and `INTAKE_CLAMAV_HOST` are present. It consumes
only durable upload identities, reloads immutable evidence, and reconciles prechecked or
lease-expired work once per minute. Keep the flag false until those dependencies and disposable
test data are ready.

Before staging admission, run `pnpm test:intake-upload-verification:disposable` on the exact release
SHA. Retain its structured success line and the matching candidate-release assessment. The gate
uses fresh local PostgreSQL, Redis, MinIO, and ClamAV containers; it does not inspect or reset the
long-lived local-staging stack or any hosted resource.

### Authoritative intake worker staging admission

This is a prepared operator procedure, not standing permission to access credentials or deploy.
Perform it only after the staging owner authorizes the exact release SHA and independently confirms
that every referenced resource is staging-only.

1. Record the full release SHA, successful candidate assessment, and successful disposable
   shakedown. Confirm all worker replicas will use that same SHA.
2. Inventory the staging database, quarantine bucket, and Redis prefix. Preserve or snapshot any
   difficult-to-reconstruct founder/customer research; use only synthetic tenant, venue, and upload
   identities for the canary. Never clear Redis broadly or reset the shared database/bucket.
3. Apply the reviewed migration set before starting the new worker. Keep
   `OUTBOUND_PROVIDER_WORKERS_ENABLED=false`, `CRM_BACKGROUND_WORKERS_ENABLED=false`, and every
   unrelated execution flag false. Set `INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED=true` only on a
   single coordinated worker replica after Redis, database, quarantine storage, and ClamAV health
   are independently green.
4. Verify startup reports only the intake-verification queue and explicitly reports outbound
   provider workers disabled. Confirm the exact `staging--intake-upload-verification` queue and one
   repeat scheduler; unexpected provider queues, mixed SHAs, or duplicate worker generations block
   admission.
5. Through the normal staging API, create one clean and one EICAR test-file upload under the
   synthetic venue. Confirm the clean version becomes `AWAITING_REVIEW`, the infected version
   becomes `REJECTED/UNSAFE_FILE`, and both preserve exact immutable-version, receipt, milestone,
   and `SYSTEM` audit lineage. Do not use customer-provided content.
6. Observe at least two reconciliation intervals. A live lease must not create another job. For a
   synthetic-only recovery case, stop the worker after its claim, allow the ten-minute lease to
   expire without editing the row, restart the same SHA, and confirm one recovery job reaches a
   terminal state. Do not shorten or overwrite a shared staging lease merely to accelerate proof.
7. Record queue depth, failed count, oldest age, final upload states, audit identities, worker SHA,
   and dependency health without copying raw file content, scanner responses, credentials, or
   signed URLs.
8. To back out, set `INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED=false` uniformly and coordinate a
   worker restart. Preserve queued and prechecked rows for roll-forward recovery; do not delete
   receipts, uploads, scheduler keys, or object versions automatically. Escalate any mixed-version
   worker, valuable-data risk, or ambiguous cleanup target.

This is a per-process guarantee. Before calling staging provider-disabled, scale down and drain every
older worker replica and prove that only the reviewed release SHA remains; an older replica could
continue consuming queued work during a rolling deploy. Dormant mode does not drain or delete old
jobs or scheduler definitions. Never use broad Redis deletion as cleanup.

For production workers, all nine controls must be explicitly set to `true` or `false`:
`OUTBOUND_PROVIDER_WORKERS_ENABLED`, `CRM_BACKGROUND_WORKERS_ENABLED`,
`INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED`, `WORKER_SCHEDULERS_ENABLED`,
`EMBEDDING_DISPATCH_ENABLED`, `GENERATION_DISPATCH_ENABLED`,
`GENERATION_RECOVERY_ENABLED`, `EVALUATION_RUNNER_ENABLED`, and
`VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED`. Omission is a startup failure, not implicit authorization.
Scheduler flags do not by themselves freeze ordinary consumers; a cutover freeze still requires
stopped/drained worker replicas and inspected queues.

For an isolated staging evaluation window, keep `OUTBOUND_PROVIDER_WORKERS_ENABLED=false`, set
`EVALUATION_RUNNER_ENABLED=true`, and keep the CRM and intake-only modes false. The worker must report
`mode=evaluation-only` and exactly the evaluation-run plus guest-answer-attribution queues. Any
unrelated queue registration, mixed worker generation, or broad provider-enabled mode blocks the
evaluation canary.

For provider-dark venue-media processing, keep `OUTBOUND_PROVIDER_WORKERS_ENABLED=false`, set
`VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED=true`, and keep the CRM, intake-verification, and evaluation
isolated modes false. The worker must report `mode=venue-media-derivative-only` and exactly the
venue-media-derivative queue. This runtime performs deterministic image transformation and
controlled-storage writes only; it does not import or construct the provider-enabled worker graph.

## Release procedure

Local destructive migration proofs must use the disposable-only wrapper, never a raw migration
script. The wrapper accepts only an explicitly named
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

### Approved isolated staging migration

Production remains forbidden. The only active external migration entrypoint is the fail-closed
wrapper below, executed from the exact Railway staging release after its non-secret resource
identity and full release SHA are independently recorded:

```bash
pnpm db:migrate:staging
```

The provider secret store—not a shell history, repository file, command argument, or log—must set
`DATABASE_URL`, `DIRECT_DATABASE_URL`, `RAILWAY_ENVIRONMENT=staging`, the provider release SHA, the
matching PathFinder release SHA, exact pooled/direct host and database confirmations, matching
runtime/operator database resource identities, `PATHFINDER_ALLOW_STAGING_MIGRATIONS=1`,
an explicitly admitted staging data policy, and a staging spend ceiling no greater than 10. For
disposable data, set `PATHFINDER_CONFIRM_STAGING_DATA_POLICY=synthetic-only`. The wrapper rejects the
known production project, SHA drift, resource drift, host/database drift, an unreviewed data policy,
missing opt-in, or a larger ceiling before Prisma starts. Remove the one-run opt-in after a
successful migration.

Before deploying, set the non-secret `PATHFINDER_RELEASE_SHA` service variable to the same exact
full revision on `staging-web`, `staging-dashboard`, and `staging-workers`. Each runtime reconciles
that value with Railway's provider commit metadata; drift can make release identity unknown and
causes exact-revision evidence paths such as the founder-absence observer to fail closed. A green
build or public web health response is not proof that all three service variables agree.

Railway's pre-deploy runtime does not inherit Docker image `ENV`. Before starting this exact web
rollout, set the non-secret Railway **web service variable**
`PATHFINDER_STAGING_MIGRATION_APPROVAL=torchiko-staging-lineage-to-206-20260830`. The value must
match both the checked-in pre-deploy contract and the staging image pin; either mismatch stops before
Prisma. After the exact migration and hosted health pass, restore
`PATHFINDER_ALLOW_STAGING_MIGRATIONS=0` without replacing the admitted active revision. A normal
deployment with the closed value is expected to stop at pre-deploy and is not a second migration
proof.

The frozen manifest identity is computed from LF-normalized migration text so it is stable across
checkouts. Ledger verification separately accepts only the exact raw-byte checksum Prisma records
for the same checked-in file, the normalized checksum, or an explicitly frozen historical baseline
exception. This distinction preserves exact ledger verification when a reviewed migration is stored
with CRLF bytes; it does not admit arbitrary checksum drift.

The reviewed 206-migration state contains 232 public tables: the B.5 boundary contains 193 and the
subsequent 64-migration suffix adds 38. The post-migration guard freezes that exact topology along
with the ordered ledger, checksums, valid indexes, and validated constraints.

If staging contains valuable or difficult-to-reconstruct work, do not label it `synthetic-only`.
Use `PATHFINDER_CONFIRM_STAGING_DATA_POLICY=preserve-existing`. That path remains blocked until the
operator supplies all of the following secret-free evidence from a separately stored logical backup
and a disposable restore rehearsal completed no more than 24 hours earlier:

- `PATHFINDER_STAGING_BACKUP_RELEASE_SHA` — the exact release being admitted;
- `PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE` — the same database resource being migrated;
- `PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE` and the identical
  `PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE` — a non-production storage resource distinct
  from the database resource;
- `PATHFINDER_STAGING_BACKUP_LEDGER_COUNT` — the migration ledger count observed in the backup and
  required to match the live predeploy ledger;
- canonical UTC `PATHFINDER_STAGING_BACKUP_CREATED_AT` and
  `PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT` timestamps;
- exact `PATHFINDER_STAGING_BACKUP_SHA256` and
  `PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256` digests.

These fields attest evidence; they do not create the backup. Do not populate them from an unverified
claim. Backup storage provisioning, credentials, and the restore rehearsal remain owner/external
gates until a separate reviewed backup mechanism and resource are available. A missing, stale,
misordered, cross-resource, same-resource, wrong-release, malformed, or ledger-mismatched proof stops
before Prisma runs. This path does not authorize a staging reset, wipe, or production-lineage restore.

Neither policy permits restoring the production-lineage archive that was previously uploaded to the
private staging container. Record migration output and a second no-pending result against the same
release and resource identity.

The synthetic seed does not trust the `staging` label alone. Before a separately authorized
synthetic seed, independently read the non-secret pooled host, direct host, and database name from
the staging provider. The operator must set `PATHFINDER_ALLOW_STAGING_SEED=1` and exact values for
`PATHFINDER_CONFIRM_STAGING_DATABASE_HOST`,
`PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST`, and
`PATHFINDER_CONFIRM_STAGING_DATABASE_NAME`. The seed refuses before its first mutation unless
`RAILWAY_ENVIRONMENT=staging`, both PostgreSQL URLs match the confirmed hosts and same confirmed
database, and the explicit opt-in is present. Never record URL credentials.

After an authorized deployment, admit the independently identified public staging web hostname
with the checked-in verifier:

```bash
pnpm verify:staging-health -- \
  --url https://pathfinder-staging.example.com/api/health \
  --expected-revision "$RELEASE_SHA" \
  --confirm-environment staging \
  --confirm-host pathfinder-staging.example.com \
  --expected-database-resource <non-secret-staging-database-id> \
  --expected-redis-resource <non-secret-staging-redis-id> \
  --expected-storage-resource <non-secret-staging-storage-id-or-disabled>
```

Replace the example hostname in both arguments with the same confirmed
staging host. The verifier rejects credentials, query strings, fragments,
redirects, cacheable responses, non-JSON or oversized bodies, degraded
dependencies, and any revision other than the full expected SHA. Its CI
test validates the contract without contacting staging; only this explicit
operator invocation performs a live request. Passing proves the public web health response only.
Immediately pair it with the read-only Railway topology admission from the linked staging project:

```bash
railway status --json | pnpm verify:staging-topology -- --expected-revision "$RELEASE_SHA"
```

The topology verifier reads at most 1 MiB from standard input, retains no raw provider payload, and
emits only the three application deployment IDs, immutable image digests, expected revision, and
bounded success/running states. It requires exactly one `staging-web`, `staging-dashboard`, and
`staging-workers` service, each with an active successful deployment at the exact revision and one
running instance; removed overlap instances are allowed, but crashed or other unexpected states
fail closed. This closes the deployment-status false green that a web-only health response cannot
detect. It still does not prove database, Redis, storage, identity-provider, or outbound-provider
isolation; retain the separate evidence for those boundaries.

If the release includes the default-off website-widget preview, run the
exact-revision widget admission from a checkout that contains `RELEASE_SHA`:

```bash
pnpm verify:staging-widget -- \
  --url https://pathfinder-staging.example.com/api/health \
  --expected-revision "$RELEASE_SHA" \
  --confirm-environment staging \
  --confirm-host pathfinder-staging.example.com \
  --expected-database-resource <non-secret-staging-database-id> \
  --expected-redis-resource <non-secret-staging-redis-id> \
  --expected-storage-resource <non-secret-staging-storage-id-or-disabled> \
  --venue-slug museum-slug \
  --expected-frame-origins-json '["https://www.museum.example"]' \
  --unlisted-venue-slug widget-admission-unlisted
```

Confirm that the negative-control slug is not a real venue and is absent
from the server-owned widget policy. Passing binds the reviewed loader bytes
and each revision-bearing frame-policy response to a healthy deployment that
reports the requested revision. It is an HTTP admission prerequisite, not browser execution proof,
production authorization, or M4 approval.

## Post-resolution external exercise archive — INERT, DO NOT EXECUTE

Every remaining section in this file is retained only as historical design input for a future
runbook. Its imperatives, queries, canaries, promotion steps, and proof checklists are suspended by
`database-incident-stop.md`. They do not authorize an external connection, inspection, write,
migration, seed, deployment, or production promotion. After Tom explicitly approves an incident
assessment and any resulting remediation plan, rewrite and rehearse each needed procedure rather
than executing this archive verbatim.

### Embedding dispatch canary

Start the workers with `EMBEDDING_DISPATCH_ENABLED=false`. Confirm the new `EmbeddingDispatch`
table and content triggers exist, then make one synthetic place or knowledge edit and verify a
single coalesced dispatch row is committed. Only after that proof, set
`OUTBOUND_PROVIDER_WORKERS_ENABLED=true` and `EMBEDDING_DISPATCH_ENABLED=true`, then restart the
staging worker with bounded test-provider credentials. The embedding flag is independent of
`WORKER_SCHEDULERS_ENABLED`, but it is rejected unless outbound-provider workers are enabled. Run
the archived smoke tests afterward; any failure would block a future production promotion and
require a new reviewed commit and complete same-SHA rerun.

### Clerk webhook receipt canary

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

### Durable generation dispatch canary

Answer-analysis and weekly-report requests now commit the domain row, request receipt, and audit
entry in one transaction. A dispatcher publishes the durable receipt to BullMQ, and the target
worker consumes the receipt only when it acquires the exact database execution claim. API kick
jobs are consumed only by provider-enabled worker deployments with
`OUTBOUND_PROVIDER_WORKERS_ENABLED=true`; `GENERATION_DISPATCH_ENABLED` controls only the
once-per-minute fallback scan that repairs a lost kick or an older `GENERATING` row with both lease
fields null.

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

### Generation recovery canary

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

### Content-history migration canary

`20260809030000_add_content_versions` establishes immutable baselines and capture triggers for
venues, places, and knowledge entries. It takes `SHARE ROW EXCLUSIVE` locks on all three source
tables for the transaction so no write can land between a baseline scan and trigger installation.
Treat the lock window as a planned staging write drain, not as a zero-downtime assumption.

1. Before the migration, record exact row counts for `venues`, `places`, and
   `venue_knowledge_entries`, current long-running transactions, and the release SHA. Measure the
   migration on a disposable populated clone at representative row counts. Schedule a write drain
   if the measured lock duration exceeds the approved staging request budget.
2. Stop or drain dashboard/API writers and content-import jobs. Confirm no active transaction is
   writing the three source tables, then use the reviewed forward-only migration step from the
   release artifact after the incident stop is lifted.
   Abort promotion if the migration waits unexpectedly or application write errors appear.
3. After commit, confirm exactly one `CREATE` baseline per pre-existing source row, all rows have
   `snapshot_schema_version = 1`, and the three capture triggers plus UPDATE/DELETE/TRUNCATE guard
   are installed. Counts must match the recorded preflight counts by entity type.
4. Using synthetic staging content, perform one create, content update, embedding-only update, and
   delete. Confirm the first three content changes produce actor-attributed versions in increasing
   sequence, the embedding-only update produces none, and the portal can restore the deletion.
5. Confirm cross-tenant history reads and reverts are denied, an attempted history-row mutation is
   rejected, and the reviewed migration status reports no pending work.

If the migration transaction fails, do not mark it applied manually: its explicit transaction must
leave no partial table, functions, triggers, or baselines. Diagnose and roll forward with a corrected
migration. After a successful migration, application rollback should retain `content_versions`, its
guards, and capture triggers; older application code does not depend on them, and dropping immutable
recovery evidence is destructive. Pause writers before rolling back application code. A destructive
down migration or history deletion requires a separately approved retention and incident decision.

### Operational-update lifecycle migration canary

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
   the reviewed migration status must report no pending work.
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

### Venue-package lifecycle migration canary

`20260809050000_add_venue_packages` adds an immutable review aggregate for strict schema-v1 venue
packages. It does not rewrite venue content. The migration creates one enum, one table, lifecycle
and immutability guards, a tenant relation, and tenant-scoped draft/command idempotency indexes.

1. Confirm the target with the disposable-migration guard and record the release SHA. No external
   migration is authorized while the `DIRECT_DATABASE_URL` incident remains unresolved.
2. Apply all migrations to a populated disposable clone. Confirm the finished migration count exactly
   matches the current repository migration directory count, then run
   the guarded deploy again and require `No pending migrations to apply`.
3. Verify the draft/approval/application/revert command-key indexes,
   `venue_packages_lifecycle_check`, `venue_packages_revision_guard`, and
   `venue_packages_truncate_guard` exist. Direct immutable-field update, delete, truncate, and an
   illegal lifecycle jump must fail without changing the revision.
4. Preview a strict v1 package and confirm it writes no content. Save and replay one explicit draft
   key, approve with the exact warning digest, then apply it. Confirm all places, knowledge, content
   versions, embedding dispatches, audit evidence, package status, and rollback manifest commit
   together. Retry each command key and require no duplicate write.
5. Apply two approved same-base packages concurrently and require one winner, one conflict, and one
   content set. Inject a late knowledge insert failure and require no place, knowledge, applied audit,
   or status transition. Revert an unchanged applied package and require the exact base digest;
   mutate venue content after apply and require the aggregate revert to fail closed. After a clean
   revert, require the same payload with a new draft key to create a new DRAFT. Apply a later package
   revision without rewriting the prior APPLIED revision.

Schema v1 is deliberately additive and supports only places and knowledge entries. Missing or
unsupported schema versions, unknown root sections, and unknown nested fields fail input parsing
before a draft or content write. A structurally valid package with a server validation error may be
retained as immutable DRAFT evidence, but approval and application remain blocked. Normalized exact
duplicates are warnings whose exact digest must be acknowledged server-side; semantic duplicate
detection and broader venue-package sections remain future work and must not be claimed by this
canary.

Application rollback is a same-SHA forward fix or `git revert` while retaining package revisions.
There is no automated Prisma down migration; any schema downgrade requires a separately reviewed
manual change after revision retention is resolved.
Do not delete package rows: the database guard intentionally makes revisions immutable. A package's
own `revertPackage` action is allowed only while all authoritative venue content still matches its
post-apply digest; otherwise use manual reviewed recovery rather than a partial rollback.

### Venue report-configuration migration canary

`20260809060000_add_venue_report_configurations` makes client-facing weekly reports an explicit,
venue-scoped capability. Absence of a configuration row means disabled. The migration does not
backfill rows or alter existing reports, so every existing venue remains hidden and unable to
request or publish reports until a platform administrator deliberately enables it.

1. Record the venue and weekly-report counts and the release SHA. Confirm there is no existing
   `venue_report_configurations` table or `venues_id_tenant_id_key`. Do not run this or any other
   external Prisma migration while the unresolved `DIRECT_DATABASE_URL` incident is unapproved.
2. Apply the migration only after the normal staging target/isolation confirmation. It runs in an
   explicit transaction. After commit, require the prior venue/report counts to be unchanged,
   configuration count to be zero, the composite venue ownership foreign key to exist, and a
   second deploy to report no pending migrations.
3. Before enabling a venue, confirm its client navigation omits Weekly Reports, direct client API
   reads fail closed, and a platform-admin generation request writes no report, dispatch, audit, or
   queue kick. Enable it from the internal report workspace and verify one strict configuration
   audit plus client navigation availability.
4. Generate and review a synthetic draft. Publishing must carry the exact displayed revision and
   write the status transition plus strict audit atomically. A stale revision, disabled venue, or
   injected audit failure must preserve DRAFT and expose no client content.
5. Disable the venue while retaining a published synthetic report. Confirm the row remains stored,
   all client reads are denied, and new generation and publication are rejected. Re-enable and
   confirm only PUBLISHED reports return; GENERATING, DRAFT, and FAILED rows remain internal.
6. Exercise concurrent disable versus new generation. The venue-scoped advisory lock must produce
   either one enabled request followed by disable, or disable followed by a no-write precondition
   failure. A request that starts after disable must never create a report.

This is the bounded default-off/access/concurrency slice of report backlog #40. Cadence scheduling,
selectable content sections, immutable generation-time configuration snapshots, and a separate
formal review status remain open and must not be claimed by this canary. Application rollback may
revert the code while retaining the additive table and disabled rows. Dropping configuration or
historical report data requires a separate reviewed migration.

### Staging smoke tests

- Run the exact-revision `verify:staging-health` admission command above and
  record its sanitized JSON result. Railway health must also be green.
- Pipe the linked staging project's `railway status --json` into `verify:staging-topology` and retain
  only its bounded three-service result. A deployment marked successful without a running web,
  dashboard, or worker instance fails this gate.
- For an enabled widget canary, run the exact-revision widget admission above,
  then preserve browser evidence from one authorized third-party test page and
  one non-allow-listed origin that CSP blocks. Record only sanitized output.
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

### Manual production promotion

Production promotion is an explicit manual approval, not an automatic effect
of a staging deployment. Promote only the exact `RELEASE_SHA` that passed every
staging smoke test. Re-check that production uses production resources and
`RAILWAY_ENVIRONMENT=production`; never seed production. Apply production
migrations using the approved migration/recovery procedure, then deploy web,
dashboard, and workers from that same SHA. If any code changes after staging
approval, it is a new release and must return to staging.

### Required proof

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
