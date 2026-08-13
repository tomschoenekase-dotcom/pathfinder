# PathFinder V2 cutover execution status

**Status date:** 2026-08-12 America/Chicago

**Release baseline:** `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`
**Current status:** local fallback chain and dump/restore smoke complete; representative
production-lineage rehearsal, staging, and production blocked

## Blocking control

The active stop in `docs/database-incident-stop.md` forbids every external database inspection,
migration, seed, rollback, and remediation command. No external database or deployment command was
run during this execution. The stop must remain active until Tom identifies the external Supabase
project affected on 2026-08-09 and explicitly approves the bounded read-only assessment described
in that document.

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

This is a structurally representative fallback rehearsal, not a production clone. The packet's
preferred production-lineage rehearsal remains blocked until the incident stop is lifted.

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

## External work not performed

The following are unproven and block production promotion:

- actual production provider and service inventory;
- production migration ledger and schema state;
- production backup identity and provider restore path;
- isolated Railway/Supabase/Redis/storage/Clerk staging resources;
- deployed staging Guest, dashboard, worker, storage, browser, security, and performance evidence;
- production cutover and post-cutover smoke evidence.

## Human action required

Tom must identify the Supabase project/environment affected by the 2026-08-09 migration incident,
then explicitly authorize the bounded read-only incident assessment. That authorization should name
the affected project and allow only non-mutating checks of project identity, migration ledger,
schema state, and backup/recovery posture. Do not paste database secrets into source files or this
document.

After that assessment, Tom must explicitly approve the resulting remediation or roll-forward plan
and every external database write it authorizes. Only then may the incident stop and its static
safety tests be lifted together in a reviewed commit.

## Requirement-by-requirement completion audit

This audit is against the 50,277-byte implementation packet last modified on 2026-08-12, SHA-256
`19B7A5DE61E100588D6145C7A72521427E7770263CADE3F490AA064BE0689024`.

| Packet requirement             | Status                 | Authoritative evidence or missing proof                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reality inventory              | Partial                | Repository structure, deployment configuration, environment contracts, Dockerfiles, health routes, queues, storage boundaries, authentication, analytics, and CI were inspected. Actual provider inventory and production state require external read-only access.                                                                                   |
| Baseline verification          | Complete locally       | Starting branch/commit/worktree were recorded. Frozen install, tests, typecheck, lint, builds, browser-foundation, accessibility, Prisma, client-bundle, and static inventories passed.                                                                                                                                                              |
| Migration audit                | Partial                | All 90 repository migrations were ordered and executed. Static classification found one extension migration, 39 enum migrations, 36 trigger migrations, 35 function migrations, 65 index migrations, 73 migrations containing NOT NULL, and five explicit table-lock migrations. Production/staging ledger and checksum reconciliation is blocked.   |
| Production backup preparation  | Blocked                | Provider, project identity, backup mechanism, snapshot identity, timestamp, size/acknowledgment, PITR posture, and recovery procedure are unknown under the incident stop.                                                                                                                                                                           |
| Representative target          | Partial fallback proof | The populated legacy fixture is the packet's allowed last-resort fallback. It built the 43-migration pre-`20260809070000` schema and preserved one tenant, venue, and venue package through the remaining chain. It does not approximate production-lineage breadth.                                                                                 |
| Migration rehearsal            | Partial fallback proof | The remaining chain passed from the populated fixture; a second guarded deploy had no pending migrations. A fresh empty target passed all 90 migrations and sampled V2 tables/triggers. Pre-state breadth, timings, provider logs, full object parity, null/data distribution, application queries, and production-lineage behavior remain unproven. |
| Restore rehearsal              | Partial local smoke    | A post-migration custom-format dump restored into a separate database and matched the source at 90 finished migrations, one venue package, and 99 public tables. This proves round-trip mechanics, not pre-migration rollback recovery or provider-native restoration.                                                                               |
| Permanent isolated staging     | Blocked                | No external PostgreSQL, Redis, storage, Guest, dashboard, worker, scheduler, logging, auth, or analytics resource was created.                                                                                                                                                                                                                       |
| Deterministic staging fixtures | Blocked                | Venue A/B/C fixtures were not seeded because no authorized isolated staging target exists.                                                                                                                                                                                                                                                           |
| Deployed end-to-end validation | Blocked                | No real staging URL or deployed service exists. Local unit, contract, and integration tests cannot substitute for deployed HTTP evidence.                                                                                                                                                                                                            |
| Real-browser validation        | Blocked                | The 164 browser-foundation tests passed in jsdom, and six axe tests passed. No Chromium, mobile viewport, or WebKit run against deployed staging occurred.                                                                                                                                                                                           |
| Worker/Redis/scheduler proof   | Partial                | Disposable Redis recovery, dispatch, terminal-redrive, and media-admission suites passed 2/2 each. Deployed worker, scheduler, database-outage, and provider-cancellation behavior remain unproven.                                                                                                                                                  |
| Storage proof                  | Blocked                | Code contracts are covered locally, but no staging object store was configured or exercised.                                                                                                                                                                                                                                                         |
| Security/isolation smoke       | Partial                | Tenant registries, procedure coverage, bypass inventory, public-surface inventory, raw-SQL inventory, bundle-secret scan, disabled external-credential boundary, and non-destructive offboarding contracts passed. Deployed cross-tenant and staging/production separation require staging.                                                          |
| Performance sanity             | Blocked                | No representative deployed endpoint exists from which to record latency, query, memory, or worker evidence.                                                                                                                                                                                                                                          |
| Production-cutover gate        | Not met                | Local baseline and fallback rehearsal are green. Staging, production ledger reconciliation, verified production backup, deployed workflows, real-browser proof, storage proof, and production health remain missing.                                                                                                                                 |
| Production cutover             | Not authorized         | The incident stop supersedes the packet's cutover intent. No production database or application action ran.                                                                                                                                                                                                                                          |
| Documentation                  | Partial                | The repository contains staging, incident-stop, disposable migration, and execution-status documentation. Actual environment topology, identifiers, URLs, provider workflows, and production recovery commands cannot be finalized without the inventory.                                                                                            |
| Independent audits             | Partial                | Three independent Codex reviewers audited migration safety, packet fidelity, and staging controls. Hermes/DeepSeek was unavailable. Findings drove seed/resource-identity hardening, receipt serialization, enum idempotency, and corrected evidence claims. Staging-isolation, cutover, and post-deploy audits remain blocked.                      |
| Final verification gate        | Partial                | Changed-file formatting and the other local gates passed, including Prisma format. The repository-wide Prettier gate remains red on 22 pre-existing mismatches; all environment and production proof is missing.                                                                                                                                     |

## Required packet handoff

### A. Final status

**Staging blocked.** The local fallback migration and restore rehearsal is complete. External staging
and production are blocked by the active database incident stop.

### B. Repository

- Starting commit: `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`.
- Ending implementation commit before this audit batch:
  `2ea64b9d28b4a6f64309529f07708dea91df82fd`.
- Commit created before this audit batch: `2ea64b9 fix: make V2 migration chain executable`.
- Audit/hardening commit: this commit (created after the verification gate passed).
- Preserved dirty entries: modified `.claude/settings.local.json`; untracked
  `build-report-s1b-task3.md` and `docs/PATHFINDER_CURRENT_ARCHITECTURE.md`.

### C. Infrastructure

No staging or production infrastructure was created, changed, or contacted. Local proof used
Docker Desktop with disposable `pgvector/pgvector:pg16` and Redis containers bound to loopback.
Those containers, their databases, and the rehearsal dump were removed after verification.

Provider names, non-secret resource identifiers, URLs, and actual staging/production separation are
unknown pending the authorized inventory.

### D. Migration evidence

- Original production migration state: unknown and not inspected.
- Repository state before repair: 86 migrations.
- Repository state after repair: 90 migrations.
- Rehearsal target: PostgreSQL 16.14 with pgvector 0.8.6, plus the populated legacy venue-package
  fixture.
- Migration set: 90 directories, from `001_identity_foundation` through
  `20260812001700_add_offboarding_export_finalization`.
- Ordered name/file-SHA manifest hash:
  `68d86d71f3dadc578c187dd37b5208bcd608387a4016687dcc1d2902798e9cc8`.
- Migrations applied: full 90-migration chain on the fresh target; the populated fixture applied the
  chain after its 43-migration legacy baseline.
- Issues found and fixed: four unsafe enum-add/use transactions and two invalid PL/pgSQL functions.
- Rehearsal result: passed; second application reported no pending migrations.
- Production result: not run.
- Exact migration duration was not retained; this must be captured during the production-lineage
  rehearsal and cutover.
- Pre-migration production schema/ledger, migration warnings and PostgreSQL logs, full
  constraint/index/function parity, legacy/null distribution, application queries, and
  worker/report/content-resolution behavior remain unproven.
- Commit `2ea64b9` inserted four predecessor enum migrations and edited six historical migrations.
  `IF NOT EXISTS` protects enum labels from partial attempts, but it does not reconcile successful
  old checksums. Before any external deploy, inspect affected ledger rows, checksums,
  `finished_at`/`rolled_back_at`, logs, and enum/schema presence. Any successful old checksum or
  unexplained state is a stop condition; never edit or blindly resolve the ledger.
- Migration `20260619000000_remove_guest_sessions` has a historical destructive join/drop risk. Its
  applied state must be established before choosing a forward repair; do not rewrite it blindly.

### E. Backup and restore evidence

- Local mechanism: PostgreSQL custom-format `pg_dump` and restore into a distinct disposable
  database.
- Local artifact: 760,039 bytes; SHA-256
  `066a74b1ae94a9cc2467580014cf49c0c33d81ac12ac25c2f47ce874fb86d6d3`.
- Local verification: source and restored target both reported 90 finished migrations, one venue
  package, and 99 public tables.
- Cleanup: the disposable artifact and databases were removed and are not recoverable.
- Production backup mechanism, artifact, verification, PITR, and recovery instructions: unknown.
- No retained local rollback command sequence exists; rebuild local proof from the guarded disposable
  runbook. The archived external runbook is inert under the incident stop.

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
- Production-lineage migration compatibility, staging behavior, and live performance are unproven.
- Provider-disabled workers are not currently startable because worker startup requires Anthropic
  and OpenAI keys even while dispatch/schedulers are disabled. Supply bounded staging keys only
  after authorization or implement and verify a genuinely non-consuming provider-disabled worker
  mode before staging.

### K. Human actions remaining

1. **P0 — identify the incident environment.** In the Supabase dashboard, identify the project on
   which the unintended 2026-08-09 migration command may have run. Supply only its non-secret project
   name or reference.
2. **P0 — authorize the bounded assessment.** Explicitly authorize non-mutating inspection of that
   project's identity, `_prisma_migrations` ledger, schema state, and backup/recovery posture. Do
   not paste a database URL, password, service key, or access token into chat or source control.
   Reply in this Codex task with:
   `I authorize a read-only assessment of Supabase project [name/ref], limited to project identity,
_prisma_migrations names/checksums/status/logs, schema state, and backup/recovery posture.`
3. **P0 — review the assessment.** Approve or reject the evidence-backed remediation/roll-forward
   plan and each external write it proposes.
4. **P1 — provide provider access through an approved operator surface.** After the stop is lifted,
   connect or operate the actual hosting/provider accounts needed to inventory production and create
   isolated staging. Credentials must remain in provider secret stores, not repository files.

### L. Readiness judgment

**Not ready for real venue QA/onboarding.** The repaired migration chain has strong local fallback
evidence, but the packet explicitly requires isolated deployed staging, real network/browser proof,
production ledger reconciliation, a verified production backup, and a successful production cutover.
Those requirements remain blocked by the unidentified external database incident.
