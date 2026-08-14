# PathFinder V2 cutover execution status

**Status date:** 2026-08-13 America/Chicago

**Release baseline:** `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`
**Current status:** verified logical backup and PostgreSQL 17.6 production-lineage migration and
recovery rehearsals complete; isolated Railway PostgreSQL 17.6, Redis, dashboard, staging web, and
dormant provider-disabled workers are online; the hosted lineage restore remains incomplete, while
production cutover remains blocked

## Blocking control

The active stop in `docs/database-incident-stop.md` forbids every external database write,
migration, seed, rollback, and remediation command. Tom authorized and supplied an authenticated
browser surface for the bounded read-only assessment of Supabase ref `zpacmfkomonxeqdiadtz`.
Read-only SQL and dashboard inspection established the ledger, relevant schema state, and recovery
posture described below. Tom then authorized a password-prompted logical backup and isolated local
rehearsal. The external database remained read-only: no production migration, schema/data write,
password reset, paid upgrade, add-on, or deployment command ran. The stop remains active pending a
separate evidence-backed production cutover approval.

## Repository starting state

- Branch: `master`.
- Starting commit: `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`.
- The branch was 179 commits ahead of `origin/master`.
- Preserved unrelated entries: `.claude/settings.local.json`, `build-report-s1b-task3.md`, and
  `docs/PATHFINDER_CURRENT_ARCHITECTURE.md`.

## Migration defects found and repaired

The repository originally contained 86 migrations. A PostgreSQL 16 + pgvector disposable run found
four enum migrations that attempted to use a new enum value before PostgreSQL could commit it. The
enum additions are now separate forward migrations, producing a 90-migration chain:

- `20260811235945_add_structured_bootstrap_source_kind`
- `20260811235955_add_file_upload_source_kind`
- `20260812001150_add_precheck_passed_upload_status`
- `20260812001550_add_universal_item_kind`

The rehearsal also found and repaired two SQL defects:

- `20260812001400_add_native_venue_deployments`: rewrote the publication-lineage expected revision
  expression into a separately assigned value so the PL/pgSQL function parses correctly.
- `20260812001500_add_native_deployment_evaluation_evidence`: schema-qualified the disposition enum
  inside a function with an empty `search_path`, and precomputed the expected snapshot version so
  the validation function parses correctly.

Focused migration-contract tests cover each repair.

Independent review subsequently hardened the four split enum steps with `IF NOT EXISTS` for partial
enum attempts and changed intake receipt validation from `FOR KEY SHARE` to `FOR UPDATE`, so a
concurrent verification-claim/status change cannot leave stale receipt authority. The complete
90-migration fresh chain and second no-pending deploy passed again after those changes.

A second local hardening pass added a worker-specific startup policy. Production worker processes
now require explicit values for all six execution controls; no omitted value enables work. Staging
can start in provider-disabled mode with only Redis configured, and that mode returns before any
shared application configuration, BullMQ queue, consumer, or scheduler construction. Seventeen
focused entrypoint/policy/runtime/registration tests passed, including bounded Redis-startup failure
without Anthropic or OpenAI keys. A disposable loopback Redis smoke then started the built dormant
entrypoint with database, Clerk, Anthropic, and OpenAI variables absent, reported zero queues, shut
down cleanly, and left no container behind.

The PostgreSQL 17.6 production-lineage rehearsal exposed one additional data-shape incompatibility:
18 historical `venue.updated` analytics events intentionally used an empty session identifier
because the old schema required a guest session for all analytics. The guest-chat migration
previously rejected those truthful non-guest events. It now preserves them while converting only
that exact event/empty-session shape to a nullable session reference, retains fail-closed rejection
for every other unresolved event, and application writers no longer invent an empty guest-session
identity for venue administration events.

## Local migration and recovery evidence

- Runtime: PostgreSQL 16.14 with pgvector 0.8.6 in an exact-loopback disposable Docker target.
- Full empty-database chain: 90/90 migrations applied; second guarded deploy reported no pending
  migrations; zero unfinished ledger rows.
- Critical V2 schema sample: all nine sampled tables and all eight sampled lifecycle/immutability
  triggers exist.
- Populated legacy fixture: the repository's venue-package migration integration fixture applied the
  full repaired chain, preserved one representative legacy package, and passed its fail-closed and
  second-deploy assertions.
- Restore rehearsal: a custom-format dump of the populated fixture was created (760,039 bytes,
  SHA-256 `066a74b1ae94a9cc2467580014cf49c0c33d81ac12ac25c2f47ce874fb86d6d3`), restored into a separate
  disposable database, and matched the source at 90 finished migrations, one venue package, and 99
  public tables.
- Redis integration: recovery, dispatch, terminal-redrive, and media-admission suites each passed
  2/2 against an exact-loopback disposable Redis container; cleanup was verified.

This fallback evidence is now supplemented by the exact production-lineage rehearsal below.

## Production-lineage backup, migration, and recovery evidence

- Source: Supabase project `zpacmfkomonxeqdiadtz`, PostgreSQL 17.6/vector 0.8.0, accessed through
  the free IPv4 session pooler with SSL required. The existing password was entered directly into
  `pg_dump`'s interactive prompt; it was not placed in chat, command arguments, environment
  variables, repository files, or captured output.
- Backup: PostgreSQL custom archive, 3,732,162 bytes, SHA-256
  `c2e34a10aae5063e60377493d7ca8f1e51bd949af6e2709e6b0c64ce095fca7a`; `pg_restore --list`
  passed. The archive, listing, manifest, and row-count evidence are retained outside the
  repository under `C:\Users\tomsc\Downloads\PathFinder-backups` and must be treated as
  production-sensitive.
- Exact isolated runtime: `pgvector/pgvector:0.8.0-pg17`, image digest
  `sha256:40b404964359299eefdd5f8518facf1886c562848cf4de13b6eaf91cb70c2b87`, PostgreSQL 17.6,
  vector 0.8.0, bound only to `127.0.0.1:55440` in the exact-name disposable container.
- Pre-state restore: 43 public tables, 3,707 rows across 22 non-empty tables, 52/52 finished
  migrations, zero failed/rolled-back/logged ledger rows, zero invalid indexes, and zero
  unvalidated constraints.
- First rehearsal: correctly stopped at `20260812000400_add_durable_guest_chat_turns`; 18
  `venue.updated` events with the historical empty-session sentinel were the only unresolved rows.
  The failed migration rolled back transactionally and no production state changed.
- Repaired rehearsal: all 38 pending migrations applied in 2.200 seconds. The result has 90/90
  finished ledger rows, zero failed/rolled-back/logged rows, 99 public tables, 443 public indexes,
  597 public constraints, 199 public functions, 201 public trigger rows, zero invalid indexes, and
  zero unvalidated constraints. The second guarded deploy reported no pending migrations and
  Prisma reported the schema up to date.
- Data preservation: all 42 pre-existing business-table counts were unchanged. Only the migration
  ledger grew from 52 to 90. All 18 non-guest `venue.updated` events were preserved with a null
  session; no non-null analytics session remains unresolved.
- Recovery rehearsal: the original pre-migration archive was restored again into the distinct
  `pathfinder_disposable_prod_recovery` database. All 43 pre-migration table counts matched and its
  ledger returned exactly 52/52 finished migrations.
- An exploratory run that enabled every optional database integration suite against one shared
  populated clone was not accepted as evidence: five assertions and seven teardown suites failed
  because global worker selectors observed pre-existing production-lineage rows and immutable audit
  history prevented the clean-database teardown assumptions. The normal package suites, focused
  migration contracts, and lineage assertions above remain green. These optional suites require
  isolated per-suite databases before they can be used as populated-clone application proof.
- Cost for the Supabase backup/rehearsal phase: $0. No plan, add-on, branch, hosted database, or
  purchase was created.

## Local verification

Passed before the migration repair batch:

- dependency install with frozen lockfile;
- typecheck: 23/23 tasks;
- lint: 13/13 packages, with one non-blocking existing `img` optimization warning;
- complete package test tasks passed (23/23); script contracts: 143 passed, one intentional skip;
- builds: 13/13;
- browser foundation: 164/164;
- axe accessibility: 6/6;
- client-bundle secret scan: 338 deliverable files across two apps;
- raw SQL, tenant bypass, tenant procedure, tenant registry, AI boundary/budget, Docker context,
  staging configuration, and public surface inventories;
- Prisma validate and generate.

After all migration repairs, the complete package test tasks passed again; the separate script
contracts reported 143 passed, one intentional skip, and zero failures. The sequential post-repair
typecheck passed 23/23 tasks; lint,
build, browser foundation, accessibility, client-bundle scanning, static inventories, Docker-context
checks, staging-config checks, and Prisma validate/generate also passed. Formatting checks passed for
every changed TypeScript and Markdown file.

The repository-wide Prettier check reported 22 pre-existing mismatches, including unrelated and
preserved files. They were not rewritten.

## External read-only assessment

- Supabase identity: organization `PathFinder`; project display name
  `tomschoenekase-dotcom's Project`; ref `zpacmfkomonxeqdiadtz`; production branch `main`; region
  `us-east-2` (East US/Ohio); dashboard status healthy.
- Database: PostgreSQL 17.6, approximately 26.48 MB, vector 0.8.0, 43 public base tables, 129 public
  routines, and 33 public triggers.
- Prisma ledger: 52 rows, all finished; zero unfinished, rolled-back, or non-empty-log rows. Every
  applied checksum matches the corresponding current repository migration file.
- Applied range: `001_identity_foundation` through
  `20260809150000_add_evaluation_persistence`. The remaining 38 repository migrations are unapplied.
- Partial-attempt check: none of the sampled post-ledger agent/intake/item tables exists, and none of
  the relevant pending enum types or labels exists. This is a clean pre-V2-chain candidate, not a
  partial enum/checksum reconciliation case.
- Recovery posture: the project is on the Free plan. The dashboard reports no scheduled backups;
  scheduled backups require Pro, and PITR is an additional paid add-on. No provider recovery point
  is available.
- Version gap closed locally: the earlier fallback used PostgreSQL 16.14/vector 0.8.6; the exact
  production-lineage rehearsal used PostgreSQL 17.6/vector 0.8.0.

## Railway inventory and staging control

- Workspace/project: `tomschoenekase-dotcom's Projects` / `serene-inspiration`, project ID
  `8621111a-4ac8-4d88-9566-4627c8a02059`.
- Existing production environment ID: `ad140532-61bb-4355-a7e3-ebb2a54d743f`.
- Production inventory: managed Redis with a persistent volume; web service `sweet-luck` with
  public Railway domain; workers service `reliable-education` with no public domain; dashboard
  service `pathfinder` with a public Railway domain. Each application service is connected to
  `tomschoenekase-dotcom/pathfinder`, branch `master`, and configured for one EU West replica.
- The observed production deployment revision was repository commit
  `5b299872c1bb3b328cc0c8a3cfac5a66c939e6d0`. The web and worker services use
  `railway.web.json` and `railway.workers.json`; the dashboard service uses `railway.json`.
- A Railway environment named `staging`, ID
  `a7a394fc-aa4e-4a45-bd3c-904419a67818`, was created through the approved operator surface.
  The safe empty-environment path was used instead of Railway's production-duplication path, so no
  production services, variables, configuration, volume, or data were copied.
- Tom approved up to `$5` incremental Railway staging usage through 2026-08-15. That narrower limit
  controls over the later general `$15`/`$50` language.
- Staging Redis service `d53ab235-d403-4d7d-b525-3ace0ef07b92` is online with isolated volume
  `41417466-09ea-498d-a25b-4333afc10117`.
- Staging PostgreSQL service `7bd81064-588f-48a5-b138-1fc86691a09b` is online with isolated volume
  `cbee6489-4252-4cbd-81f0-bad7cad70efa`, private DNS only, and no public endpoint. Its source is
  pinned to `pgvector/pgvector:0.8.0-pg17`; startup logs prove PostgreSQL 17.6. The generated
  password is sealed and was never displayed or retrieved.
- Railway's one-click PostgreSQL template first created an empty PostgreSQL 18 service and volume.
  They were immediately deleted before use because they did not match the approved 17.6 target.
  No data was loaded into that discarded resource.
- No application service, domain, production variable, production data, or production configuration
  was copied or deployed. Production was not changed.
- Billing posture observed before resource creation: existing Hobby usage-based subscription,
  `$0.20` current workspace usage against `$5.00` included usage for the Aug 11-Sep 11 period;
  `serene-inspiration` showed `$0.2023` current cost. Compute, Redis, and volumes are usage-billed.
- After the database and Redis came online, workspace usage still displayed `$0.20`, while project
  cost moved from `$0.2023` to `$0.2039` (a displayed increase of `$0.0016`). This is below the
  approved `$5` ceiling. No plan, add-on, or purchase was created.

## Railway hosted application evidence

- Dedicated remote branch `codex/pathfinder-v2-staging` was created from commit `2023553`; the
  production branch `master` was not updated.
- Staging web service `9fec9bdb-1915-4bee-8213-f6c3d434baa1`, dashboard service
  `b2f6989e-a7bc-4ad9-8ed4-a39dd67b947f`, and workers service
  `7c551d35-b2d4-4ab0-917f-9680ccdee86a` are connected only to that dedicated branch. Their
  config-as-code files are `railway.staging.web.json`, `railway.staging.dashboard.json`, and
  `railway.staging.workers.json` respectively.
- The dashboard reached Railway `Online` state. The workers reached `Online` state and emitted
  `workers.started` with `mode: provider-disabled`, `outboundProviderWorkersEnabled: false`, and
  `queues: []`. No Anthropic, OpenAI, email, storage, or other outbound-provider credential was
  supplied.
- The web service has the staging-only public domain
  `https://staging-web-staging-bbeb.up.railway.app`. Its first corrected-image admission exposed a
  missing Clerk SDK build-time variable. A synthetic, non-secret test-format value was added as
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; this does not make Clerk authentication functional. The
  replacement image built, started on `0.0.0.0:8080`, and reached Railway `Online`; Railway's
  internal healthcheck passed. Railway's public domain was then corrected from port 3000 to 8080.
  A public request returned HTTP 200 with `environment: staging`, database and queue both `up`,
  revision `2c2e300`, the exact isolated PostgreSQL and Redis service IDs, and storage `disabled`.
- Web and dashboard reference only the isolated staging PostgreSQL and Redis services. All worker
  execution controls are explicitly `false`; the worker has Redis only and no database, Clerk, or
  provider credential. Non-secret resource fingerprints identify the staging PostgreSQL and Redis
  service IDs, with storage explicitly marked `disabled`.
- Computer Use successfully selected the verified production-lineage archive through the Windows
  file picker. Railway uploaded `pathfinder-zpacmfkomonxeqdiadtz-20260813T222746Z.dump` into the
  private PostgreSQL container root and displayed it as 3.6 MB. The authenticated browser-control
  connection could not remain attached to Railway's live terminal, and Computer Use policy forbids
  typing terminal commands, so no hosted restore or migration ran. The service remains private; no
  TCP proxy or temporary database credential was created.
- These are persistent, usage-billed staging resources. They are reversible and isolated, but they
  are not disposable until explicitly removed. Production services, variables, data, deployments,
  and `master` remain unchanged.
- After all five hosted staging services were running, Railway showed `$0.21` current workspace
  usage and `$0.2076` current cost for `serene-inspiration`. Relative to the `$0.2023` pre-staging
  project observation, the displayed increase is `$0.0053`, well below the approved `$5` limit.
  No paid plan change, add-on, or purchase was created.

## External work not performed

The following are unproven and block production promotion:

- production variable values and backing-resource identities (not opened during this inventory);
- production-lineage restore and migration rehearsal on the hosted staging PostgreSQL target;
- isolated storage and functional Clerk staging identities;
- deployed staging Guest, dashboard, worker, storage, browser, security, and performance evidence;
- production cutover and post-cutover smoke evidence.

## Human action required

The reviewed repository was published only to the dedicated branch
`codex/pathfinder-v2-staging`; Railway production auto-deploys `master`, so that production branch
remains forbidden. The completed command was:

```powershell
git -C C:\Users\tomsc\Downloads\PathFinder push origin HEAD:refs/heads/codex/pathfinder-v2-staging
```

This command created only the dedicated staging branch and did not update `master`. Railway's three
staging application services now use it. A separate production cutover plan and approval are still
required; no production write is implied by the rehearsal or staging authorization.

Exact approval response in this Codex task, if Tom chooses to authorize the next phase after review:

> I approve the reviewed PathFinder V2 production cutover plan for Supabase project
> zpacmfkomonxeqdiadtz, including only the exact production writes and stop conditions stated in
> that plan. Do not proceed until the plan is presented to me and I approve it.

After the rehearsal, Tom must separately approve or reject the evidence-backed production cutover
plan and every production write it proposes. Only then may the incident stop and its static safety
tests be lifted together in a reviewed commit.

## Requirement-by-requirement completion audit

This audit is against the 50,277-byte implementation packet last modified on 2026-08-12, SHA-256
`19B7A5DE61E100588D6145C7A72521427E7770263CADE3F490AA064BE0689024`.

| Packet requirement             | Status                 | Authoritative evidence or missing proof                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reality inventory              | Partial                | Repository structure and Supabase/Railway identities were inspected. Railway production contains web, dashboard, workers, and Redis services; source/config/revision/region/replicas were captured without opening variables. Exact variable values and backing-resource identities remain unproven.                                                                                                             |
| Baseline verification          | Complete locally       | Starting branch/commit/worktree were recorded. Frozen install, tests, typecheck, lint, builds, browser-foundation, accessibility, Prisma, client-bundle, and static inventories passed.                                                                                                                                                                                                                          |
| Migration audit                | Partial                | All 90 repository migrations were ordered and executed locally. Production has 52 finished rows through `20260809150000`, zero failed/rolled-back/logged rows, and zero checksum mismatches; the 38 later migrations and sampled post-ledger artifacts are absent. Staging rehearsal and full schema/data parity remain blocked.                                                                                 |
| Production backup preparation  | Complete logical proof | A 3,732,162-byte custom-format archive was created with an interactive password prompt, verified by archive listing and SHA-256, retained outside the repository, and restored twice locally. Provider-native scheduled backup/PITR remains absent on the Free plan.                                                                                                                                             |
| Representative target          | Complete local lineage | The verified production archive restored into isolated PostgreSQL 17.6/vector 0.8.0 with 43 tables, 3,707 rows, 22 non-empty tables, and the exact 52-migration ledger. This is exact local production lineage, not hosted deployed staging.                                                                                                                                                                     |
| Migration rehearsal            | Complete local lineage | The first run exposed the 18-event legacy sentinel conflict. After a scoped repair, all 38 pending migrations passed in 2.200 seconds; all 90 ledger rows finished, object-validity checks passed, existing business-table counts were preserved, and the second deploy had no pending work.                                                                                                                     |
| Restore rehearsal              | Complete local logical | The pre-migration archive restored into a distinct recovery database after the migrated clone existed; all 43 pre-migration table counts and all 52 finished ledger rows matched. Provider-native recovery remains unavailable.                                                                                                                                                                                  |
| Permanent isolated staging     | Partial                | Isolated Railway PostgreSQL 17.6/vector 0.8.0 and Redis services are online with separate staging volumes. Dedicated-branch web, dashboard, and provider-disabled workers are online; public health proves the exact staging resource fingerprints, and the worker log proves zero queues and outbound providers disabled. Hosted lineage restore, storage, functional Clerk/auth, and analytics remain missing. |
| Deterministic staging fixtures | Blocked                | Venue A/B/C fixtures were not seeded because the new isolated target is still empty and has not received the reviewed production-lineage restore/migrations.                                                                                                                                                                                                                                                     |
| Deployed end-to-end validation | Partial                | The public staging health endpoint returned HTTP 200 with database and queue `up` and exact staging resource fingerprints. Clerk remains deliberately synthetic/nonfunctional, the hosted lineage restore is absent, and no Guest/dashboard/storage/provider end-to-end flow ran.                                                                                                                                |
| Real-browser validation        | Blocked                | The 164 browser-foundation tests passed in jsdom, and six axe tests passed. No Chromium, mobile viewport, or WebKit run against deployed staging occurred.                                                                                                                                                                                                                                                       |
| Worker/Redis/scheduler proof   | Partial                | Disposable Redis suites passed 2/2 each. The hosted staging worker is online and logged provider-disabled mode, outbound providers false, and zero queues without AI keys. This proves the reviewed process is dormant, but scheduler-enabled behavior, outage recovery, and provider cancellation remain unproven.                                                                                              |
| Storage proof                  | Blocked                | Code contracts are covered locally, but no staging object store was configured or exercised.                                                                                                                                                                                                                                                                                                                     |
| Security/isolation smoke       | Partial                | Tenant registries, procedure coverage, bypass inventory, public-surface inventory, raw-SQL inventory, bundle-secret scan, disabled external-credential boundary, and non-destructive offboarding contracts passed. Deployed cross-tenant and staging/production separation require staging.                                                                                                                      |
| Performance sanity             | Blocked                | No representative deployed endpoint exists from which to record latency, query, memory, or worker evidence.                                                                                                                                                                                                                                                                                                      |
| Production-cutover gate        | Not met                | Backup, ledger reconciliation, PostgreSQL 17.6 production-lineage rehearsal, logical recovery, and non-secret Railway service inventory are green. Hosted staging workflows, real-browser proof, storage/provider proof, exact resource identity, and production health/cutover authorization remain missing.                                                                                                    |
| Production cutover             | Not authorized         | The incident stop supersedes the packet's cutover intent. No production database or application action ran.                                                                                                                                                                                                                                                                                                      |
| Documentation                  | Partial                | The repository contains staging, incident-stop, disposable migration, and execution-status documentation. Actual environment topology, identifiers, URLs, provider workflows, and production recovery commands cannot be finalized without the inventory.                                                                                                                                                        |
| Independent audits             | Partial                | Three independent Codex reviewers audited migration safety, packet fidelity, and staging controls. Hermes/DeepSeek was unavailable. Findings drove seed/resource-identity hardening, receipt serialization, enum idempotency, and corrected evidence claims. Staging-isolation, cutover, and post-deploy audits remain blocked.                                                                                  |
| Final verification gate        | Partial                | Changed-file formatting and the other local gates passed, including Prisma format. The repository-wide Prettier gate remains red on 22 pre-existing mismatches; all environment and production proof is missing.                                                                                                                                                                                                 |

## Required packet handoff

### A. Final status

**Local production-lineage rehearsal complete; isolated hosted PostgreSQL, Redis, web, dashboard,
and dormant workers are online; hosted lineage restore remains incomplete.**
Production remains blocked by the active database incident stop and requires a separate reviewed
cutover approval.

### B. Repository

- Starting commit: `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`.
- Latest committed handoff before hosted staging resources:
  `7d237cf docs: record Railway staging inventory`.
- Earlier migration and staging hardening commits include `2ea64b9`, `c75135a`, `d0c0ef7`,
  `7d248b0`, `89cfad0`, and `9b18d34`.
- Hosted Railway PostgreSQL/Redis and dedicated-branch application staging handoff: this commit.
- Preserved dirty entries: modified `.claude/settings.local.json`; untracked
  `build-report-s1b-task3.md` and `docs/PATHFINDER_CURRENT_ARCHITECTURE.md`.

### C. Infrastructure

The Railway staging environment now contains isolated PostgreSQL 17.6/vector 0.8.0 and Redis
services, each with its own staging volume, plus dedicated-branch web, dashboard, and dormant
workers. The PostgreSQL service is private-only, uses a sealed generated password, and exposes no
public TCP endpoint. No production variable, production data, or production configuration was
copied. No production infrastructure was changed. A public HTTPS reachability check to the
explicitly authorized Supabase ref returned
`401`; it used no credential and read no database or control-plane state. Local proof used Docker
Desktop with
disposable PostgreSQL 16 fallback,
PostgreSQL 17.6/vector 0.8.0 lineage/recovery, and Redis targets bound to loopback. The PostgreSQL
17 disposable container and its derivative databases were removed after verification; they are
recoverable from the retained archive. Unrelated Odysseus containers were not modified.

The affected provider/project is Supabase organization `PathFinder`, project display name
`tomschoenekase-dotcom's Project`, ref `zpacmfkomonxeqdiadtz`, production branch `main`, region
`us-east-2`. Its database dashboard was healthy during the read-only assessment. Railway project
`serene-inspiration` contains production web (`sweet-luck`), workers
(`reliable-education`), dashboard (`pathfinder`), and Redis services. The staging database and Redis
service/volume identifiers differ from production. Application, storage, and auth separation remain
unproven. Other provider identities remain unknown.

### D. Migration evidence

- Production ledger: 52 finished migrations through
  `20260809150000_add_evaluation_persistence`; zero unfinished, rolled-back, or non-empty-log rows.
- All 52 production checksums match the current repository files. The 38 later repository
  migrations are unapplied.
- Sampled post-ledger agent/intake/item tables and relevant pending enum types/labels are absent;
  there is no evidence of a partial/manual V2 attempt.
- Production runtime: PostgreSQL 17.6, vector 0.8.0, approximately 26.48 MB, with 43 public base
  tables, 129 public routines, and 33 public triggers.
- Repository state before repair: 86 migrations.
- Repository state after repair: 90 migrations.
- Rehearsal target: exact PostgreSQL 17.6 with vector 0.8.0 restored from the production logical
  archive; PostgreSQL 16.14/vector 0.8.6 remains fallback evidence.
- Migration set: 90 directories, from `001_identity_foundation` through
  `20260812001700_add_offboarding_export_finalization`.
- Ordered name/file-SHA manifest hash (SHA-256 of newline-terminated, name-space-file-SHA rows):
  `eab9578d000d7c0d2526404cf15cdc6ea32bb167c2028ca1e17664e61660ff83`.
- Migrations applied: full 90-migration chain on the fresh target; the populated fixture applied the
  chain after its 43-migration legacy baseline.
- Issues found and fixed: four unsafe enum-add/use transactions, two invalid PL/pgSQL functions,
  and one production-lineage analytics sentinel incompatibility.
- Rehearsal result: 38 pending migrations passed in 2.200 seconds; second application reported no
  pending migrations.
- Production migration result: not run; only authorized read-only queries were executed.
- Exact production-lineage duration was 2.200 seconds on the local disposable target. This is not a
  production downtime forecast; production timing and lock behavior still require the cutover gate.
- Full production constraint/index/function parity, legacy/null distribution, application queries,
  and worker/report/content-resolution behavior remain unproven.
- Commit `2ea64b9` inserted four predecessor enum migrations and edited six historical migrations.
  `IF NOT EXISTS` protects enum labels from partial attempts, but it does not reconcile successful
  old checksums. Before any external deploy, inspect affected ledger rows, checksums,
  `finished_at`/`rolled_back_at`, logs, and enum/schema presence. Any successful old checksum or
  unexplained state is a stop condition; never edit or blindly resolve the ledger.
- Migration `20260619000000_remove_guest_sessions` is recorded successful and its checksum matches
  the current file. Its historical destructive join/drop risk therefore cannot be repaired by
  rewriting the migration; lost/misattributed legacy rows, if any, require independent retained
  evidence, and no provider backup exists.

### E. Backup and restore evidence

- Production logical mechanism: PostgreSQL 17 `pg_dump` custom format over SSL through Supabase's
  free IPv4 session pooler, with the password entered only into the interactive client prompt.
- Production artifact: 3,732,162 bytes; SHA-256
  `c2e34a10aae5063e60377493d7ca8f1e51bd949af6e2709e6b0c64ce095fca7a`.
- Archive verification: `pg_restore --list` passed; manifest hash recheck matched.
- Recovery verification: a separate pre-migration recovery restore matched all 43 table counts and
  52/52 finished ledger rows.
- Retention: the production-sensitive archive, listing, manifest, and row-count CSVs are outside
  the repository in `C:\Users\tomsc\Downloads\PathFinder-backups`.
- Recovery procedure: create an isolated PostgreSQL 17.6/vector 0.8.0 database, pre-create vector
  in `public`, restore with owner/ACL replay disabled, compare every pre-migration table count, and
  require exactly 52 finished ledger rows. Never restore over production without separate approval.
- Local mechanism: PostgreSQL custom-format `pg_dump` and restore into a distinct disposable
  database.
- Local artifact: 760,039 bytes; SHA-256
  `066a74b1ae94a9cc2467580014cf49c0c33d81ac12ac25c2f47ce874fb86d6d3`.
- Local verification: source and restored target both reported 90 finished migrations, one venue
  package, and 99 public tables.
- Cleanup: the disposable artifact and databases were removed and are not recoverable.
- Production provider posture: Supabase Free plan, no scheduled backups and no PITR. The dashboard
  states scheduled backups require Pro and PITR is a paid add-on.
- Provider-native backups and PITR remain unavailable; the logical archive is the verified recovery
  point. No provider restore was attempted.

### F. End-to-end evidence

No deployed end-to-end workflow was tested. Local package, script-contract, and focused integration
coverage passed, but authentication, venue setup, generalized content, Guest chat, Support, upload
intake, Weekly Reports, native deployment, compatibility packages, evaluation, and offboarding must
still be exercised through a deployed staging environment.

### G. Browser evidence

- jsdom browser-foundation tests: 164/164 passed.
- axe accessibility tests: 6/6 passed.
- Real engines: none.
- Real viewport categories: none.
- Deployed browser flows: none.
- Browser defects fixed: none, because deployed browser behavior was not exercised.
- Deployed browser-console, network, hydration, focus, overflow, and stale-scope evidence: missing.

### H. Worker, storage, and provider evidence

- Disposable Redis: four suites passed, two tests per suite.
- Deployed worker and scheduler: not tested.
- Object storage: not tested against a real store.
- AI, email, malware, resource-safety, credential, or other paid provider execution: not run.

### I. Security and isolation evidence

Static tenant, SQL, public-surface, AI, Docker-context, and browser-bundle inventories passed. No
secret was detected in the committed diff or bundle scan; disposable tests used synthetic
credentials. External credentials and MCP remain disabled; destructive offboarding remains absent.
Actual staging/production separation, deployed negative cross-tenant probes, server-error leakage,
production-secret separation, raw-locator DTO behavior, and internal AgentRun/evaluation exposure
remain unproven over deployed boundaries.

The staging seed now requires an exact explicit opt-in plus independently confirmed pooled host,
direct host, and database name before its first mutation. Production-mode staging runtime also
requires non-secret database and Redis resource fingerprints, and the staging health/widget
admission commands require exact operator-confirmed fingerprints. These are configuration fences,
not cryptographic proof of backing-resource ownership; provider-console identity evidence remains
mandatory.

### J. Known limitations

- Resource-safety and malware authorities are not enabled; uploads must remain quarantined without
  all three valid receipts.
- External credentials and MCP authentication/use remain disabled.
- Offboarding stops at non-delivered, non-revoked, non-deleted export readiness.
- Evaluation remains advisory.
- `NATIVE_CORE_V1` intentionally excludes ITEM; native ITEM deployment and `NATIVE_CORE_V2` are
  absent.
- Payments are absent.
- Local production-lineage migration compatibility is proven; hosted staging behavior, production
  lock timing, and live performance remain unproven.
- The verified lineage archive is present in the private staging PostgreSQL container, but the
  hosted restore and migration rehearsal have not run. They require a real Railway terminal
  session: browser control could not retain the live terminal connection, while Computer Use is
  intentionally prohibited from entering terminal commands. This is a tooling limitation, not an
  authorization gap.
- Provider-disabled workers now have a connectivity-only mode that requires Redis but creates no
  BullMQ queues, consumers, or schedulers and requires no outbound-provider key. This is only a
  per-process guarantee; staging still must prove old replicas are drained and only the reviewed SHA
  remains. Production workers fail startup unless every execution control is explicitly declared.

### K. Human actions remaining

1. **P0 — incident assessment complete.** The production ledger is a clean 52-migration pre-V2
   candidate with matching checksums and no sampled partial artifacts.
2. **P0 — complete the hosted staging rehearsal.** In Railway's `pgvector` service terminal,
   restore the already-uploaded verified archive into the isolated PostgreSQL 17.6 database, then
   run the reviewed migration and validation procedure. Do not target production. This step could
   not be automated because the authenticated browser terminal connection repeatedly reset and
   Computer Use may not type terminal commands.
3. **P0 — review the completed local logical backup, PostgreSQL 17.6 lineage rehearsal, scoped
   analytics repair, and recovery restore.** No backup or provider add-on cost was incurred.
4. **P0 — separately approve or reject a presented production cutover plan.** The prior approval
   authorizes no production migration or schema/data write.
5. **P0 — keep staging isolated.** The dedicated branch is published and connected. Do not merge
   or push it to `master`; Railway production auto-deploys that branch.
6. **P1 — provide remaining provider surfaces only when requested.** Clerk, object storage, and any
   other staging identities must be configured through approved operator surfaces. Credentials must
   remain in provider secret stores, not repository files.

### L. Readiness judgment

**Not ready for real venue QA/onboarding.** Ledger reconciliation, a verified logical backup,
PostgreSQL 17.6 production-lineage migration rehearsal, and a separate recovery restore are now
complete. Isolated hosted PostgreSQL 17.6/vector 0.8.0, Redis, web, dashboard, and provider-disabled
workers now exist on the dedicated staging branch, and the public staging health endpoint is green.
The packet still requires hosted lineage restore/migration, functional auth/storage, and real
browser/provider proof. Production requirements remain blocked by the active external database
incident stop and require a separate approved cutover.
