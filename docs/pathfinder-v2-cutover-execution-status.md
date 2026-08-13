# PathFinder V2 cutover execution status

**Status date:** 2026-08-13 America/Chicago

**Release baseline:** `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`
**Current status:** verified logical backup and PostgreSQL 17.6 production-lineage migration and
recovery rehearsals complete; deployed staging and production cutover remain blocked

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
- Cost: $0. No plan, add-on, branch, hosted staging resource, or purchase was created.

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

## External work not performed

The following are unproven and block production promotion:

- actual non-database production provider and service inventory;
- isolated Railway/Supabase/Redis/storage/Clerk staging resources;
- deployed staging Guest, dashboard, worker, storage, browser, security, and performance evidence;
- production cutover and post-cutover smoke evidence.

## Human action required

Tom must now review the completed backup, rehearsal, repair, and recovery evidence and separately
approve or reject a production cutover plan. No production write is implied by the rehearsal
authorization.

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

| Packet requirement             | Status                 | Authoritative evidence or missing proof                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reality inventory              | Partial                | Repository structure, deployment configuration, environment contracts, Dockerfiles, health routes, queues, storage boundaries, authentication, analytics, and CI were inspected. Actual provider inventory and production state require external read-only access.                                                                                                                                       |
| Baseline verification          | Complete locally       | Starting branch/commit/worktree were recorded. Frozen install, tests, typecheck, lint, builds, browser-foundation, accessibility, Prisma, client-bundle, and static inventories passed.                                                                                                                                                                                                                  |
| Migration audit                | Partial                | All 90 repository migrations were ordered and executed locally. Production has 52 finished rows through `20260809150000`, zero failed/rolled-back/logged rows, and zero checksum mismatches; the 38 later migrations and sampled post-ledger artifacts are absent. Staging rehearsal and full schema/data parity remain blocked.                                                                         |
| Production backup preparation  | Complete logical proof | A 3,732,162-byte custom-format archive was created with an interactive password prompt, verified by archive listing and SHA-256, retained outside the repository, and restored twice locally. Provider-native scheduled backup/PITR remains absent on the Free plan.                                                                                                                                     |
| Representative target          | Complete local lineage | The verified production archive restored into isolated PostgreSQL 17.6/vector 0.8.0 with 43 tables, 3,707 rows, 22 non-empty tables, and the exact 52-migration ledger. This is exact local production lineage, not hosted deployed staging.                                                                                                                                                             |
| Migration rehearsal            | Complete local lineage | The first run exposed the 18-event legacy sentinel conflict. After a scoped repair, all 38 pending migrations passed in 2.200 seconds; all 90 ledger rows finished, object-validity checks passed, existing business-table counts were preserved, and the second deploy had no pending work.                                                                                                             |
| Restore rehearsal              | Complete local logical | The pre-migration archive restored into a distinct recovery database after the migrated clone existed; all 43 pre-migration table counts and all 52 finished ledger rows matched. Provider-native recovery remains unavailable.                                                                                                                                                                          |
| Permanent isolated staging     | Blocked                | No external PostgreSQL, Redis, storage, Guest, dashboard, worker, scheduler, logging, auth, or analytics resource was created.                                                                                                                                                                                                                                                                           |
| Deterministic staging fixtures | Blocked                | Venue A/B/C fixtures were not seeded because no authorized isolated staging target exists.                                                                                                                                                                                                                                                                                                               |
| Deployed end-to-end validation | Blocked                | No real staging URL or deployed service exists. Local unit, contract, and integration tests cannot substitute for deployed HTTP evidence.                                                                                                                                                                                                                                                                |
| Real-browser validation        | Blocked                | The 164 browser-foundation tests passed in jsdom, and six axe tests passed. No Chromium, mobile viewport, or WebKit run against deployed staging occurred.                                                                                                                                                                                                                                               |
| Worker/Redis/scheduler proof   | Partial                | Disposable Redis recovery, dispatch, terminal-redrive, and media-admission suites passed 2/2 each. The built provider-disabled entrypoint also started against disposable loopback Redis with database, Clerk, and AI variables absent, reported zero queues, shut down cleanly, and left no container. Deployed worker, scheduler, database-outage, and provider-cancellation behavior remain unproven. |
| Storage proof                  | Blocked                | Code contracts are covered locally, but no staging object store was configured or exercised.                                                                                                                                                                                                                                                                                                             |
| Security/isolation smoke       | Partial                | Tenant registries, procedure coverage, bypass inventory, public-surface inventory, raw-SQL inventory, bundle-secret scan, disabled external-credential boundary, and non-destructive offboarding contracts passed. Deployed cross-tenant and staging/production separation require staging.                                                                                                              |
| Performance sanity             | Blocked                | No representative deployed endpoint exists from which to record latency, query, memory, or worker evidence.                                                                                                                                                                                                                                                                                              |
| Production-cutover gate        | Not met                | Backup, ledger reconciliation, PostgreSQL 17.6 production-lineage rehearsal, and logical recovery are green. Hosted staging workflows, real-browser proof, storage/provider proof, exact production service inventory, and production health/cutover authorization remain missing.                                                                                                                       |
| Production cutover             | Not authorized         | The incident stop supersedes the packet's cutover intent. No production database or application action ran.                                                                                                                                                                                                                                                                                              |
| Documentation                  | Partial                | The repository contains staging, incident-stop, disposable migration, and execution-status documentation. Actual environment topology, identifiers, URLs, provider workflows, and production recovery commands cannot be finalized without the inventory.                                                                                                                                                |
| Independent audits             | Partial                | Three independent Codex reviewers audited migration safety, packet fidelity, and staging controls. Hermes/DeepSeek was unavailable. Findings drove seed/resource-identity hardening, receipt serialization, enum idempotency, and corrected evidence claims. Staging-isolation, cutover, and post-deploy audits remain blocked.                                                                          |
| Final verification gate        | Partial                | Changed-file formatting and the other local gates passed, including Prisma format. The repository-wide Prettier gate remains red on 22 pre-existing mismatches; all environment and production proof is missing.                                                                                                                                                                                         |

## Required packet handoff

### A. Final status

**Local production-lineage rehearsal complete; deployed staging blocked.** Production remains
blocked by the active database incident stop and requires a separate reviewed cutover approval.

### B. Repository

- Starting commit: `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`.
- Last committed implementation before this continuation:
  `c75135a fix: harden V2 staging and migration admission`.
- Earlier migration repair commit: `2ea64b9 fix: make V2 migration chain executable`.
- Provider-disabled worker and incident-identity hardening: this commit.
- Preserved dirty entries: modified `.claude/settings.local.json`; untracked
  `build-report-s1b-task3.md` and `docs/PATHFINDER_CURRENT_ARCHITECTURE.md`.

### C. Infrastructure

No hosted staging or production infrastructure was created or changed. A public HTTPS reachability check
to the explicitly authorized Supabase ref returned `401`; it used no credential and read no database
or control-plane state. Local proof used Docker Desktop with disposable PostgreSQL 16 fallback,
PostgreSQL 17.6/vector 0.8.0 lineage/recovery, and Redis targets bound to loopback. The PostgreSQL
17 disposable target is retained temporarily for evidence review; unrelated Odysseus containers
were not modified.

The affected provider/project is Supabase organization `PathFinder`, project display name
`tomschoenekase-dotcom's Project`, ref `zpacmfkomonxeqdiadtz`, production branch `main`, region
`us-east-2`. Its database dashboard was healthy during the read-only assessment. Other provider
identities and actual staging/production separation remain unknown.

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
- Provider-disabled workers now have a connectivity-only mode that requires Redis but creates no
  BullMQ queues, consumers, or schedulers and requires no outbound-provider key. This is only a
  per-process guarantee; staging still must prove old replicas are drained and only the reviewed SHA
  remains. Production workers fail startup unless every execution control is explicitly declared.

### K. Human actions remaining

1. **P0 — incident assessment complete.** The production ledger is a clean 52-migration pre-V2
   candidate with matching checksums and no sampled partial artifacts.
2. **P0 — review the completed logical backup, PostgreSQL 17.6 lineage rehearsal, scoped analytics
   repair, and recovery restore.** No cost was incurred.
3. **P0 — separately approve or reject a presented production cutover plan.** The prior approval
   authorizes no production migration or schema/data write.
4. **P1 — provide provider access through an approved operator surface.** After the stop is lifted,
   connect or operate the actual hosting/provider accounts needed to inventory production and create
   isolated staging. Credentials must remain in provider secret stores, not repository files.

### L. Readiness judgment

**Not ready for real venue QA/onboarding.** Ledger reconciliation, a verified logical backup,
PostgreSQL 17.6 production-lineage migration rehearsal, and a separate recovery restore are now
complete. The packet still requires isolated deployed staging, real network/browser/storage/provider
proof, exact service inventory, and an explicitly approved successful production cutover. Those
requirements remain blocked by the active external database incident stop.
