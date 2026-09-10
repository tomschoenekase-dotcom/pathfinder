# Migration 236–247 recovery review

> **Migration instruction status: INCIDENT STOP — DO NOT EXECUTE EXTERNAL DATABASE COMMANDS.**

This is a proposed staging recovery decision, not authorization to recover an external database. The production stop in [database-incident-stop.md](database-incident-stop.md) remains ACTIVE. The canonical staging entrypoint and existing approval remain unchanged. The local runner uses only the existing disposable wrapper and new native loopback databases.

Migration 246 has an explicit transaction around its seven-table lock, contradiction check, canonical claim backfill and enforcement installation. A contradiction rolls that transaction back, but Prisma can retain an unfinished failed ledger row. Repeating the deploy must refuse that ledger. Neither deletion of evidence nor marking the migration resolved is an admitted recovery path.

## Proposed operator decision

Before staging is admitted, designate the release and recovery operator and establish a write drain across web, dashboard, workers and integrations. Retain a backup from that quiescent boundary. Keep the drain in effect until migration and read-back pass, so restoration cannot silently lose acknowledged work.

Preferred recovery is to retain the failed database and its logs, then restore the exact verified pre-upgrade staging backup into a new separately identified staging resource. That resource must pass the existing database identity, production denylist, checksum, topology and preservation gates before cutover. Replacement resource IDs and application variables must be reviewed together. Reuse the canonical migration wrapper for any subsequent suffix application.

If the backup contains a real duplicate/content contradiction, restoration preserves that contradiction and migration must still refuse. Stop admission and obtain a scoped reconciliation decision that preserves every source/outcome record. There is no approved automatic forward repair or schema downgrade.

## Required concrete hosted receipt

The following values are unavailable and must remain explicit blockers until grounded in current provider state:

The integration lead's read-only staging inspection on 2026-09-10 observed PostgreSQL 17.6 (Debian 17.6-1.pgdg12+1), 207 ledger rows, tip `20260901020000_support_tenant_wide_ai_accounting`, and no unfinished, unrolled migration. The authenticated provider browser console exposed `pg_dump` 17.6; CLI SSH remained unavailable. These observations establish the current inspection surface, not a backup or a restore receipt. The previously admitted 208–236 suffix still precedes this 237–247 proposal.

| Required field                                                       | Current status                                    |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Named release/recovery operator                                      | Owner designation required                        |
| Exact source and restored staging database resource IDs              | Current provider read-back required               |
| Separate backup-storage resource ID                                  | Not supplied                                      |
| Backup archive identity, SHA-256, timestamp and source ledger        | Actual hosted backup required                     |
| Restore proof identity, SHA-256, timestamp and row/schema comparison | Actual matching restore proof required            |
| Exact approved provider restore/reclone command or UI operation      | Unavailable; cannot be inferred from old examples |
| Write-drain cutoff and no-loss check                                 | Not observed                                      |
| Failed attempt ledger and log archive                                | Capture if a hosted failure occurs                |
| Restored private host/database fingerprints                          | Verify before admitting replacement resource      |
| Full application release SHA and migration manifest                  | Freeze the integrated admitted candidate          |

Existing preserved-data admission requires ordered backup and restoration timestamps no older than 24 hours, matching full release SHA, matching database resource and ledger count, and separately confirmed backup storage. Supplying syntactically valid attestations does not create or verify any backup. Synthetic-only data classification does not authorize discarding retained staging evidence.

## Local mechanism proof

The new `scripts/run-migration-236-247-rehearsal.mjs` constructs exact Git-byte 236/245/247 snapshots and invokes `runDisposableMigration` for every schema transition. Each run creates new named databases, keeps contradictory failures and their ledger entries, and constructs its corrected case independently.

It takes a PostgreSQL custom-format logical backup of a quiescent synthetic 245 fixture, verifies its archive listing and SHA-256, restores into a different fresh disposable database, and compares the entire migration ledger and logical application snapshots before advancing to 247. This validates a local mechanism only. Consult its final retained result for the actual pass/fail state; this document does not assert success independently of that result.

The retained local engine is PostgreSQL 16.15. A local 16.15 dump/restore does not establish compatibility with the actual staging 17.6 archive. Admission requires a verified actual staging backup and a matching restore using compatible PostgreSQL 17 tooling and a separately identified disposable destination.

Preservation means exact logical row values projected onto the predecessor columns, including timestamps and evidence hashes, with explicit assertions for the added defaults. Failed-migration schema comparison covers public columns, constraints, triggers and functions; it does not claim to compare every PostgreSQL schema object. The runner records the selected candidate lock hash but uses the existing installed Prisma runtime through a junction. It does not prove a clean dependency installation from that lock or the complete application candidate. Integration must freeze and verify the final application revision separately.

## Stop and read-back criteria

Stop on unexpected migration names/checksums, incomplete ledger state, changed candidate bytes, table topology mismatch, invalid indexes or constraints, unexpected row/content/timestamp changes, contradiction diagnostics, missing backup evidence or incomplete restoration verification. An interrupted migration reopens the ledger and recovery gate; do not treat an application redeploy as database repair.

The operator must approve a numeric lock and overall deployment budget using the measured rehearsal observations and actual hosted workload. The local lock observation is not a production latency guarantee. Drain writers first; retain backend PID, blocking relation, wait duration, final transaction outcome and error logs. Restore/cutover remains blocked until all concrete hosted receipt fields above are filled and reviewed.

After a successful database change, application rollback means immutable redeployment of a previously admitted compatible revision while retaining the additive schema and evidence. Production migration or restoration needs its separate incident-stop decision.
