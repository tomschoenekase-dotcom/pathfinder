# PathFinder V2 cutover execution status

**Status date:** 2026-08-15 America/Chicago

**Release baseline:** `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`
**Current status:** verified logical backup, local recovery rehearsal, and isolated hosted
PostgreSQL 17.6 production-lineage migration rehearsal complete; Railway PostgreSQL, Redis,
dashboard, staging web, dormant provider-disabled workers, isolated Clerk authentication, and
basic isolated object storage are online; production cutover remains blocked

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

Deployed Clerk webhook testing exposed a second provider-contract incompatibility. Clerk's current
`organizationMembership.created` example supplies the primary email as
`public_user_data.identifier`, while PathFinder accepted only the older optional
`email_addresses[]` shape. The first membership deliveries correctly failed closed with HTTP 503.
Commit `21005be` accepts a validated email-shaped identifier as a fallback for user sync and welcome
admission; 38 focused database/dashboard tests and both package typechecks passed, and the exact
signed membership example then succeeded against hosted staging.

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
- Prisma ledger: 52 rows, all finished; zero unfinished, rolled-back, or non-empty-log rows. Three
  applied checksums differ from the canonical LF-normalized files. Two differences are exactly the
  CRLF-byte variants of the same SQL; the third, weekly-digest checksum is retained as an exact
  production-lineage value and its resulting enum/table/constraint/index schema is fingerprinted
  before any later migration is admitted.
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
- The dashboard now has the staging-only public domain
  `https://staging-dashboard-staging-dc4a.up.railway.app`. A distinct Clerk development application,
  `PathFinder Staging`, is configured only for that service. Its publishable, secret, and webhook
  signing values are held in Railway/Clerk provider stores and are not committed to the repository.
  A replacement signed endpoint subscribes only to `organization.created` plus membership create,
  update, and delete. Clerk reported successful hosted deliveries for `organization.created` and,
  after the current-payload compatibility repair, `organizationMembership.created`.
- A disposable Clerk test-format user was created through the deployed dashboard sign-up surface,
  verified with Clerk's development-instance test code, and assigned as the sole member of
  `PathFinder Staging QA` (`org_3HxlN3WTSsCOSlbn2hpdfWYJtMo`). The deployed app activated that
  organization and reached its authenticated `/onboarding/setup` workspace. The generated password
  was kept transient and cleared after sign-in. Clerk's real organization delivery succeeded; the
  matching membership delivery retried from one failed attempt to success.
- During endpoint inspection the first webhook signing secret was rendered into operator-visible
  tool output. That endpoint was immediately deleted, invalidating the exposed secret. A replacement
  endpoint and secret were created and transferred without rendering the value; only the replacement
  endpoint remains active.
- Railway bucket `reserved-tote`, resource ID `0a9b3c58-0c9e-47de-96ae-38df297996e8`, was created
  only in the staging environment. Dashboard and workers hold the bucket endpoint, region, name,
  access key, and secret in Railway variables; web holds only the non-secret resource fingerprint.
  A first credential transfer used Railway's masked secret display and correctly failed S3 signing
  with HTTP 403 without creating an object. The actual revealed secret replaced it in both services
  and all transient copies were cleared.
- The exact application S3 client configuration then passed a bounded PUT, HEAD metadata check, GET
  byte comparison, DELETE, and post-delete 404. The validation object was removed. Railway returned
  no version ID, consistent with its documented lack of object versioning. Basic media/export
  storage is functional, but immutable quarantine intake cannot pass PathFinder's required version
  check on this provider. CORS/presigned browser upload remains unproven.
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
- Computer Use selected the verified production-lineage archive through the Windows file picker.
  Railway uploaded `pathfinder-zpacmfkomonxeqdiadtz-20260813T222746Z.dump` into the private
  PostgreSQL container root. Tom ran the reviewed fail-closed restore block in that private
  terminal; SHA-256 and archive-list verification passed and the postcheck returned
  `RESTORE_OK: 43|52|52|0|0|0`.
- A staging-only pre-deploy runner then admitted only the exact Railway environment, web service,
  database resource, private hostname, database name, approval token, frozen 90-file manifest,
  and verified 52-row ledger. Two dry attempts stopped before migration while exposing image and
  checksum evidence. Deployment `687d82ed-af50-4f87-aaa4-2b4ce4b84d05` applied all 38 pending
  migrations and reported `90/90 ledger and integrity checks passed`; all pre-existing business
  table counts were unchanged, 99 public tables remained, and there were no invalid indexes or
  unvalidated constraints. Revision `765f231f3b40d0a97dd14007bf80ad69455f5298` became active.
- Follow-up deployment `0bc9ac93-06ad-490e-b55f-125a39cd9d14` admitted the exact completed
  90-row ledger, reported `already complete (90/90); integrity checks passed`, applied nothing,
  and activated revision `672dfdd95e6c3b9cdbbbe4a9532b338f05620ea2`.
- The active public health response is HTTP 200 with `ok: true`, exact staging environment/database/
  Redis/storage fingerprints, database and queue `up`, and revision `21005be`. The
  landing page plus `/riverside-aquarium` and `/riverside-aquarium/chat` returned HTTP 200; the
  default-disabled embed surface returned 404 as configured. No production endpoint was invoked.
- These are persistent, usage-billed staging resources. They are reversible and isolated, but they
  are not disposable until explicitly removed. Production services, variables, data, deployments,
  and `master` remain unchanged.
- After all five hosted staging services were running, Railway showed `$0.21` current workspace
  usage and `$0.2076` current cost for `serene-inspiration`. Relative to the `$0.2023` pre-staging
  project observation, the displayed increase is `$0.0053`, well below the approved `$5` limit.
  No paid plan change, add-on, or purchase was created.
- After the restore, migration builds, and repeat deployment, project usage was `$0.41` with a
  `$1.59` estimate. The current increase from the `$0.2023` pre-staging observation is `$0.2077`;
  even the displayed estimate remains below the approved `$5` incremental ceiling.

## External work not performed

The following are unproven and block production promotion:

- production variable values and backing-resource identities (not opened during this inventory);
- versioning-capable quarantine storage;
- deployed staging Guest, completed venue onboarding, worker consumption, broad browser, security, and
  performance evidence;
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

| Packet requirement             | Status                  | Authoritative evidence or missing proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reality inventory              | Partial                 | Repository structure and Supabase/Railway identities were inspected. Railway production contains web, dashboard, workers, and Redis services; source/config/revision/region/replicas were captured without opening variables. Exact variable values and backing-resource identities remain unproven.                                                                                                                                                                                                                          |
| Baseline verification          | Complete locally        | Starting branch/commit/worktree were recorded. Frozen install, tests, typecheck, lint, builds, browser-foundation, accessibility, Prisma, client-bundle, and static inventories passed.                                                                                                                                                                                                                                                                                                                                       |
| Migration audit                | Partial                 | All 90 repository migrations were ordered and executed locally and on the isolated hosted production-lineage clone. Production has 52 finished rows through `20260809150000`, zero failed/rolled-back/logged rows, and three reconciled historical checksum differences. Full production schema/data parity and live-workload lock behavior remain unproven.                                                                                                                                                                  |
| Production backup preparation  | Complete logical proof  | A 3,732,162-byte custom-format archive was created with an interactive password prompt, verified by archive listing and SHA-256, retained outside the repository, and restored twice locally. Provider-native scheduled backup/PITR remains absent on the Free plan.                                                                                                                                                                                                                                                          |
| Representative target          | Complete hosted lineage | The verified production archive restored into isolated Railway PostgreSQL 17.6/vector 0.8.0 with 43 public tables and the exact 52-row migration ledger. The target has a distinct staging-only service, volume, database name, and private resource identity.                                                                                                                                                                                                                                                                |
| Migration rehearsal            | Complete hosted lineage | The guarded hosted run reconciled the exact 52-row ledger, applied all 38 pending migrations, reached 90/90, passed object-validity checks, preserved every pre-existing business-table row count, and activated a healthy application revision. Local lineage and second-deploy evidence also remain green.                                                                                                                                                                                                                  |
| Restore rehearsal              | Complete local logical  | The pre-migration archive restored into a distinct recovery database after the migrated clone existed; all 43 pre-migration table counts and all 52 finished ledger rows matched. Provider-native recovery remains unavailable.                                                                                                                                                                                                                                                                                               |
| Permanent isolated staging     | Partial                 | Isolated Railway PostgreSQL 17.6/vector 0.8.0, Redis, and a private S3-compatible bucket are online with separate staging identities. Dedicated-branch web, dashboard, and provider-disabled workers are online; health proves exact resource fingerprints. A distinct Clerk staging application, public dashboard domain, and signed webhook are functional. Versioning-capable quarantine storage remains missing.                                                                                                          |
| Deterministic staging fixtures | Partial                 | The production-lineage clone supplies real restored venues, including the existing Riverside Aquarium path. Packet-specific Venue A/B/C deterministic fixture coverage was not seeded because mixing synthetic fixtures into the lineage clone would weaken count-preservation evidence.                                                                                                                                                                                                                                      |
| Deployed end-to-end validation | Partial                 | Health returned HTTP 200 with database/queue `up`, exact database/Redis/storage fingerprints, and revision `21005be`. Landing, Riverside Aquarium venue, and chat routes returned 200. A disposable real-browser Clerk user was created and verified, the `PathFinder Staging QA` organization and membership synchronized, and its authenticated onboarding workspace loaded. Application-style storage PUT/HEAD/GET/DELETE passed with cleanup. Venue onboarding, browser upload, and outbound-provider flows remain unrun. |
| Real-browser validation        | Partial                 | The 164 browser-foundation tests and six axe tests passed. A real in-app browser completed deployed Clerk sign-up and development verification, selected `PathFinder Staging QA`, and loaded authenticated `/onboarding/setup`. Engine/version and exact viewport were not independently reported; no mobile or WebKit flow ran.                                                                                                                                                                                              |
| Worker/Redis/scheduler proof   | Partial                 | Disposable Redis suites passed 2/2 each. The hosted staging worker is online and logged provider-disabled mode, outbound providers false, and zero queues without AI keys. This proves the reviewed process is dormant, but scheduler-enabled behavior, outage recovery, and provider cancellation remain unproven.                                                                                                                                                                                                           |
| Storage proof                  | Partial                 | Isolated Railway storage passed application-style PUT, HEAD metadata, GET byte equality, DELETE, and post-delete 404 with cleanup. Exact health identity is green. Railway does not support object versioning, so PathFinder's immutable quarantine intake rejects this provider; CORS, presigned browser upload, multipart, and worker consumption remain unproven.                                                                                                                                                          |
| Security/isolation smoke       | Partial                 | Tenant registries, procedure coverage, bypass inventory, public-surface inventory, raw-SQL inventory, bundle-secret scan, disabled external-credential boundary, and non-destructive offboarding contracts passed. Deployed cross-tenant and staging/production separation require staging.                                                                                                                                                                                                                                   |
| Performance sanity             | Partial                 | Hosted health and public route reachability passed, but no representative latency distribution, query plan, memory profile, or active-worker load evidence was recorded.                                                                                                                                                                                                                                                                                                                                                      |
| Production-cutover gate        | Not met                 | Backup, ledger reconciliation, hosted PostgreSQL 17.6 lineage migration, logical recovery, exact staging resource identity, real-user Clerk authentication, basic S3 storage, and deployed reachability are green. Versioning-capable quarantine storage, completed onboarding, broader browser/provider, performance, production health, and explicit cutover authorization remain missing.                                                                                                                                  |
| Production cutover             | Not authorized          | The incident stop supersedes the packet's cutover intent. No production database or application action ran.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Documentation                  | Partial                 | The repository records the staging topology, identifiers, public URLs, restore/migration evidence, real-user Clerk authentication and webhook results, basic S3 round trip and versioning limitation, incident stop, and logical recovery procedure. Completed venue onboarding, quarantine/browser storage, other provider workflows, and an approved production cutover procedure remain incomplete.                                                                                                                        |
| Independent audits             | Partial                 | Three independent Codex reviewers audited migration safety, packet fidelity, and staging controls. Hermes/DeepSeek was unavailable. Findings drove seed/resource-identity hardening, receipt serialization, enum idempotency, and corrected evidence claims. Staging-isolation, cutover, and post-deploy audits remain blocked.                                                                                                                                                                                               |
| Final verification gate        | Partial                 | Changed-file formatting and the other local gates passed, including Prisma format. The repository-wide Prettier gate remains red on 22 pre-existing mismatches; functional environment and all production cutover proof remain missing.                                                                                                                                                                                                                                                                                       |

## Required packet handoff

### A. Final status

**Hosted production-lineage migration rehearsal complete; isolated PostgreSQL, Redis, web,
dashboard, and dormant workers are online and healthy.**
Production remains blocked by the active database incident stop and requires a separate reviewed
cutover approval.

### B. Repository

- Starting commit: `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`.
- Latest committed handoff before hosted staging resources:
  `7d237cf docs: record Railway staging inventory`.
- Earlier migration and staging hardening commits include `2ea64b9`, `c75135a`, `d0c0ef7`,
  `7d248b0`, `89cfad0`, and `9b18d34`.
- Hosted Railway PostgreSQL/Redis, production-lineage runner, and dedicated-branch application
  staging commits through deployed revision `672dfdd`; the final evidence-only documentation
  commit is intentionally retained locally to avoid triggering another application deployment.
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
- The 52-row production ledger has three exact historical checksum differences. Two are proven
  CRLF-only byte variants of the current SQL. The weekly-digest checksum is frozen as observed and
  its resulting schema fingerprint is required. The 38 later migrations were unapplied in
  production and applied only to the isolated clone.
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
  `0a1fa6265665304dbdfdf190e9fbefe9fd275ce72052d022ccef042a554b0583`.
- Migrations applied: full 90-migration chain on the fresh target; the populated fixture applied the
  chain after its 43-migration legacy baseline.
- Issues found and fixed: four unsafe enum-add/use transactions, two invalid PL/pgSQL functions,
  and one production-lineage analytics sentinel incompatibility.
- Rehearsal result: locally, 38 pending migrations passed in 2.200 seconds and a second application
  reported no pending work. Hosted staging then applied the same 38 migrations and passed the
  90-row ledger, 99-table, index, constraint, and row-count-preservation gates. A subsequent hosted
  pre-deploy run accepted the completed 90-row ledger, reran integrity checks, and applied nothing.
- Production migration result: not run; only authorized read-only queries were executed.
- Exact production-lineage duration was 2.200 seconds on the local disposable target. This is not a
  production downtime forecast; production timing and lock behavior still require the cutover gate.
- Full production constraint/index/function parity, legacy/null distribution, application queries,
  and worker/report/content-resolution behavior remain unproven.
- Commit `2ea64b9` inserted four predecessor enum migrations and edited six later, unapplied
  migration files. `IF NOT EXISTS` protects enum labels from partial attempts, but does not itself
  reconcile successful old checksums. The hosted runner therefore requires the exact observed
  baseline checksums, explicit CRLF equivalence where proven, and a schema fingerprint for the one
  historical weekly-digest artifact not retained in Git. Any other checksum or state remains a
  stop condition; the ledger was never edited or resolved.
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
- Hosted restore verification: the archive hash recheck passed inside the exact private Railway
  PostgreSQL service; the empty PostgreSQL 17 precheck passed, and the postcheck returned
  `RESTORE_OK: 43|52|52|0|0|0` before any migration runner was deployed.
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

Deployed health plus landing, restored venue, and chat route reachability passed. The last recorded
web health check used revision `672dfdd`; Clerk compatibility revision `21005be` subsequently became
online across the dedicated staging services. A disposable user completed the isolated dashboard's
Clerk sign-up and development verification flow, selected `PathFinder Staging QA`, and reached its
authenticated onboarding workspace. Signed organization and current-shape membership webhooks
completed through the hosted database. This is supplemented by a cleaned-up S3 PUT/HEAD/GET/DELETE
round trip. This is not a full end-to-end workflow: completed venue setup, generalized content,
Guest message generation, Support,
versioned upload intake, Weekly Reports, native deployment, compatibility packages, evaluation,
and offboarding still require functional staging providers and broader browser runs.

### G. Browser evidence

- jsdom browser-foundation tests: 164/164 passed.
- axe accessibility tests: 6/6 passed.
- Real browser: in-app browser completed deployed Clerk sign-up, development verification, QA
  organization selection, and authenticated onboarding; its engine/version was not independently
  reported.
- Real viewport categories: one default desktop surface; exact dimensions were not captured.
- Deployed browser flows: unauthenticated redirect, isolated Clerk sign-up and verification,
  organization selection, and authenticated `/onboarding/setup` render.
- Browser/provider defect fixed: current Clerk membership email moved from the legacy
  `email_addresses[]` assumption to validated `identifier` fallback.
- Deployed browser-console, network, hydration, focus, overflow, and stale-scope evidence: missing.

### H. Worker, storage, and provider evidence

- Disposable Redis: four suites passed, two tests per suite.
- Deployed worker: online after storage configuration and still reported provider-disabled mode,
  outbound providers false, and zero queues. Scheduler-enabled behavior remains untested.
- Object storage: isolated Railway bucket passed application-style PUT, HEAD metadata verification,
  GET, DELETE, and post-delete absence. It returned no version ID; Railway documents object
  versioning as unsupported, so immutable intake quarantine is not admitted.
- Clerk: isolated development application and dashboard domain are live. Signed
  `organization.created` and `organizationMembership.created` deliveries succeeded; membership
  create initially failed closed on the current payload shape and passed after commit `21005be`.
  A disposable test-format user is the sole member of `PathFinder Staging QA`; its real membership
  delivery retried from one failed attempt to success, and the organization loaded in the app.
- AI, email, malware, resource-safety, credential, or other paid provider execution: not run.

### I. Security and isolation evidence

Static tenant, SQL, public-surface, AI, Docker-context, and browser-bundle inventories passed. No
secret was detected in the committed diff or bundle scan; disposable tests used synthetic
credentials. Clerk credentials are held only by provider stores. The first webhook secret was
briefly rendered to operator-visible tool output, then invalidated by deleting that endpoint; the
replacement secret was transferred without rendering it and is the only active endpoint secret.
External credentials and MCP remain disabled; destructive offboarding remains absent.
Actual staging/production separation, deployed negative cross-tenant probes, server-error leakage,
production-secret separation, raw-locator DTO behavior, and internal AgentRun/evaluation exposure
remain unproven over deployed boundaries.

The staging seed now requires an exact explicit opt-in plus independently confirmed pooled host,
direct host, and database name before its first mutation. Production-mode staging runtime also
requires non-secret database and Redis resource fingerprints, and the staging health/widget
admission commands require exact operator-confirmed fingerprints. These are configuration fences,
not cryptographic proof of backing-resource ownership; provider-console identity evidence remains
mandatory.

Web health now exposes the exact non-secret storage resource ID alongside database and Redis. The
bucket is private and isolated per Railway environment. Its access credentials are provider-held;
no value was committed. Railway bucket versioning is unavailable, so this resource must not be
treated as satisfying the stronger immutable-intake storage authority.

### J. Known limitations

- Resource-safety and malware authorities are not enabled; uploads must remain quarantined without
  all three valid receipts.
- Railway storage supports the basic S3 operations used by media and exports but not object
  versioning. PathFinder intake verification deliberately rejects objects without a version ID;
  use a separate versioning-capable private bucket before enabling quarantine intake.
- External credentials and MCP authentication/use remain disabled.
- Offboarding stops at non-delivered, non-revoked, non-deleted export readiness.
- Evaluation remains advisory.
- `NATIVE_CORE_V1` intentionally excludes ITEM; native ITEM deployment and `NATIVE_CORE_V2` are
  absent.
- Payments are absent.
- Production-lineage migration compatibility is proven locally and on isolated hosted staging;
  production lock timing and live performance remain unproven.
- Provider-disabled workers now have a connectivity-only mode that requires Redis but creates no
  BullMQ queues, consumers, or schedulers and requires no outbound-provider key. This is only a
  per-process guarantee; staging still must prove old replicas are drained and only the reviewed SHA
  remains. Production workers fail startup unless every execution control is explicitly declared.

### K. Human actions remaining

1. **P0 — incident assessment complete.** The production ledger is a clean 52-migration pre-V2
   candidate with three reconciled historical checksum differences and no sampled partial artifacts.
2. **P0 — review the completed hosted staging rehearsal.** The exact archive restored successfully,
   all 38 pending migrations applied only to the isolated clone, the repeat pre-deploy applied
   nothing, and revision `672dfdd` is healthy.
3. **P0 — review the completed local logical backup, PostgreSQL 17.6 lineage rehearsal, scoped
   analytics repair, and recovery restore.** No backup or provider add-on cost was incurred.
4. **P0 — separately approve or reject a presented production cutover plan.** The prior approval
   authorizes no production migration or schema/data write.
5. **P0 — keep staging isolated.** The dedicated branch is published and connected. Do not merge
   or push it to `master`; Railway production auto-deploys that branch.
6. **P1 — finish staging provider surfaces.** Disposable Clerk sign-up, verification, organization
   selection, and authenticated onboarding entry are complete; finish the five-step venue onboarding
   flow. Basic Railway object storage is configured, but a versioning-capable private provider is
   required before quarantine intake. Any further credentials must remain in provider secret stores,
   not repository files.

### L. Readiness judgment

**Ready for limited public-route and authenticated-onboarding staging QA, but not completed venue
onboarding or production cutover.** Ledger reconciliation, verified logical backup, hosted PostgreSQL 17.6
production-lineage migration, and separate recovery restore are complete. Isolated PostgreSQL,
Redis, web, dashboard, and provider-disabled workers are online and the public health endpoint is
green. Disposable-user Clerk sign-up, organization selection, authenticated onboarding entry, and
signed organization/membership synchronization are green. Completed venue onboarding,
versioning-capable quarantine storage, broader browser/provider flows, performance evidence, and
production cutover approval remain required. The active production database incident
stop remains in force.
