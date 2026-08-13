# PathFinder V2 cutover execution status

**Status date:** 2026-08-12 America/Chicago

**Release baseline:** `0d5a1ca9c715eb4a54d8ceffb24e9354a114a23d`
**Current status:** local migration rehearsal complete; external staging and production blocked

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
- complete package tests and script contracts: 137 passed, one intentional skip;
- builds: 13/13;
- browser foundation: 164/164;
- axe accessibility: 6/6;
- client-bundle secret scan: 338 deliverable files across two apps;
- raw SQL, tenant bypass, tenant procedure, tenant registry, AI boundary/budget, Docker context,
  staging configuration, and public surface inventories;
- Prisma validate and generate.

After all migration repairs, the complete package and script test gate passed again: 137 passed, one
intentional skip, and zero failures. The sequential post-repair typecheck passed 23/23 tasks; lint,
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
