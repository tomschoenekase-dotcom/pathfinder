# Packet B.5 staging migration recovery

## Diagnosis

Railway staging stopped with `unexpected ledger row count 134` because the B.5 guard admitted
only the previously reviewed boundaries at 52, 93, 112, 125, 132, 133, and 141 migrations. It
omitted the immediately preceding staging release boundary at 134.

The omitted boundary is not arbitrary:

- the previously admitted Railway release was
  `c128e63d206479673eda0f5d417a560476ee6bc0`;
- that commit added migration 134,
  `20260821032000_allow_pending_stripe_customer_link`;
- its frozen manifest required 134 migrations and 175 public tables;
- it is an ancestor of the owner-approved B.5 staging merge
  `04fa565907bc8092274f22fae75bb3f15d13ed78`.

The failure therefore identifies a release-guard omission, not evidence that the database has
drifted. The failed B.5 guard rejected the row count before it inspected migration names or
checksums, so the live database must still pass the repaired exact-prefix check before migration.

## Repair

The staging guard now recognizes the prior 134-migration release as `previous-release` only when:

- all 134 names are the exact ordered prefix of the frozen 141-file manifest;
- every checksum matches the canonical migration bytes (including the three documented historical
  checksum exceptions);
- every migration is finished, none is rolled back, and no ledger row contains failure logs;
- the database still has the expected 175 public tables;
- all existing Railway staging identity, release SHA, migration token, database-resource,
  staging-only, synthetic-data, and spend-ceiling checks pass.

It then permits Prisma to apply only this reviewed suffix:

1. `20260821172000_add_verified_actor_audit`
2. `20260821173500_add_approval_grants`
3. `20260821190000_add_company_brain_crm_meetings`
4. `20260821193000_add_portable_agent_workers`
5. `20260821194500_add_company_knowledge_embeddings`
6. `20260821200000_sync_mcp_credential_capabilities`
7. `20260821201000_add_meeting_processing_capability`

The guard remains fail-closed for altered, missing, duplicate, unfinished, rolled-back, failed,
future, and unknown ledger states.

## Local proof

A disposable pgvector/PostgreSQL 16 rehearsal using canonical Git LF bytes proved:

- starting state: exact 134-row ledger, 175 public tables, zero unfinished, rolled-back, or failed
  migrations;
- transition: exactly the seven migrations listed above;
- final state: exact 141-row ledger, 193 public tables, zero unfinished, rolled-back, or failed
  migrations, zero invalid indexes, and zero unvalidated constraints;
- final Prisma status: schema up to date;
- guard classification: `previous-release` before migration and `complete` afterward.

`pnpm test`, `pnpm test:scripts`, `pnpm verify:staging`, and the database package typecheck pass on
the recovery branch. Live Railway evidence and the final admitted merge SHA are recorded after the
owner-approved recovery PR is merged and deployed.

## Live staging baseline before recovery

Read-only inspection on 2026-08-21 established:

- `staging-web` remains online on the previously admitted release
  `c128e63d206479673eda0f5d417a560476ee6bc0`;
- the failed B.5 web deployment used the owner-approved merge
  `04fa565907bc8092274f22fae75bb3f15d13ed78` and stopped at predeploy with
  `unexpected ledger row count 134`, before Prisma or the application started;
- the public staging health endpoint returns HTTP 200 with database and queue dependencies up, but
  reports revision `unknown`, so it cannot yet prove exact-SHA admission;
- the database, Redis, and storage resource identities match the approved Railway staging packet;
- `staging-workers` is online on B.5 but logs `mode: provider-disabled` and `queues: []`;
- none of the seven worker execution variable names is present on `staging-workers`, so the empty
  queue list is the expected safe-off result, not CRM-only readiness.

The minimal owner-controlled release path is:

1. review and merge `codex/torchiko-staging-migration-recovery-20260821` into
   `codex/pathfinder-v2-staging` after its required check passes;
2. set `PATHFINDER_RELEASE_SHA` on `staging-web` to that resulting full merge SHA and redeploy;
3. set `OUTBOUND_PROVIDER_WORKERS_ENABLED=false` and `CRM_BACKGROUND_WORKERS_ENABLED=true` on
   `staging-workers`; no other execution flag needs to be enabled for CRM-only mode;
4. admit the web deployment only if the repaired predeploy proves the exact live 134-row prefix,
   applies exactly the seven-migration suffix, and reaches the frozen 141-row/193-table state;
5. require postdeploy health to report the same merge SHA, database and queue dependencies up, and
   worker startup to report `mode: crm-only` with only `prospect-import` and
   `account-summary-refresh` queues.

No manual database mutation or migration repair is authorized by this runbook.

## Production boundary

This recovery changes only the Railway staging admission path. It does not merge to `master`, touch
production resources, enable provider-backed workers, enable outreach, configure Google OAuth, or
enable production MCP.
