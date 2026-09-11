# Migration 236–247 recovery review

> **Migration instruction status: INCIDENT STOP — DO NOT EXECUTE EXTERNAL DATABASE COMMANDS.**

This is a proposed staging recovery decision, not authorization to recover an external database. The production stop in [database-incident-stop.md](database-incident-stop.md) remains ACTIVE. The canonical staging entrypoint is retained; its reviewed local endpoint is now 247/264 with an explicit 236/256 predecessor. The code approval value does not authorize hosted recovery. Local rehearsals use the existing disposable wrapper and new loopback databases.

Migration 246 has an explicit transaction around its seven-table lock, contradiction check, canonical claim backfill and enforcement installation. A contradiction rolls that transaction back, but Prisma can retain an unfinished failed ledger row. Repeating the deploy must refuse that ledger. Neither deletion of evidence nor marking the migration resolved is an admitted recovery path.

## Proposed operator decision

Before staging is admitted, designate the release and recovery operator and establish a write drain across web, dashboard, workers and integrations. Retain a backup from that quiescent boundary. Keep the drain in effect until migration and read-back pass, so restoration cannot silently lose acknowledged work.

The concrete proposed recovery retains the failed database and its logs, restores the exact verified pre-upgrade staging archive into a new named database inside the same existing staging PostgreSQL service, verifies the restored data and properties, then performs two transactional database renames. Both original OIDs/databases and independent failed-state archives remain retained. This avoids inventing a provider clone or new resource. Root must finish the exact command/backup/candidate receipt and obtain Tom's explicit approval before a hosted restore or identity cutover. The reviewed local rename mechanism proves active-session refusal, rollback when the second rename fails, and preservation of both OIDs; it is not hosted permission. No drop, clean-in-place, resolve, or automatic retry is proposed.

If the backup contains a real duplicate/content contradiction, restoration preserves that contradiction and migration must still refuse. Stop admission and obtain a scoped reconciliation decision that preserves every source/outcome record. There is no approved automatic forward repair or schema downgrade.

## Required concrete hosted receipt

The following table separates established preflight evidence from the remaining hosted gates:

The integration lead's authenticated staging inspection on 2026-09-10 observed PostgreSQL 17.6, 207 ledger rows, tip `20260901020000_support_tenant_wide_ai_accounting`, and no unfinished, unrolled migration. It created and downloaded a full owner/ACL-preserving archive through the existing console. The [retained full-archive preflight](evidence/staging-full-archive-restore-preflight-2026-09-10.json) pins the archive, source and independent review. Local PostgreSQL 17.11 restored two copies, upgraded one through 247, and preserved the other as recovery evidence. The hosted database was not changed. The previously admitted 208–236 suffix still precedes 237–247.

| Required field                                                       | Current status                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named release/recovery operator                                      | Root Astra Medium; Tom approves hosted recovery                                                                                                             |
| Exact source and restored staging database resource IDs              | Existing service `7bd81064-588f-48a5-b138-1fc86691a09b`; proposed new database in same service, not yet created                                             |
| Separate backup-storage resource ID                                  | Confirmed workstation storage `workstation:THOMAS_COMPUTER:torchiko-staging-release-backups-20260910`; Tom/SYSTEM/Administrators ACL, no automatic deletion |
| Backup archive identity, SHA-256, timestamp and source ledger        | Full preflight 20:46:11UTC, SHA `71e1ea6a06fabab392ccb8c9ec496b9a70bd43a6bfc659e8abe9850b4b6c9ea7`,207 rows; final drained backup still required            |
| Restore proof identity, SHA-256, timestamp and row/schema comparison | Full local result SHA `ae6bbe8390ec1f1e2fd0cb5642c6184c86de3010d4beb8b7c519218764f86497`; exact final candidate refresh still required                      |
| Exact approved restore and cutover operation                         | Concrete same-resource restore/two-rename proposal prepared in final launch packet; Tom approval and final receipt pending                                  |
| Write-drain cutoff and no-loss check                                 | Not observed                                                                                                                                                |
| Failed attempt ledger and log archive                                | Capture if a hosted failure occurs                                                                                                                          |
| Restored private host/database fingerprints                          | Recheck same-resource host, restored database name/OID and full properties before any cutover                                                               |
| Full application release SHA and migration manifest                  | Freeze the integrated admitted candidate                                                                                                                    |

Existing preserved-data admission requires ordered backup and restoration timestamps no older than 24 hours, matching full release SHA, matching database resource and ledger count, and separately confirmed backup storage. Supplying syntactically valid attestations does not create or verify any backup. Synthetic-only data classification does not authorize discarding retained staging evidence.

Full preflight preservation covers the complete 207 ledger, 231 application tables (65 populated),
two sequence definitions/states/dependencies, eight schema catalogues, object owners and ACLs,
and all 40 newly applied SQL checksums. Fifteen inherited checksums match exact CRLF bytes; one
weekly-digest checksum uses the existing canonical historical fingerprint rule. No exception or
ledger was changed. The local engine/vector versions differ from hosted 17.6/vector0.8.0;
recorded and actual libc collation versions are both 2.36. Root's source metadata is an explicit
console-readback attestation. The retained container is stopped with its port released (exit 137),
which does not prove graceful shutdown or restart durability. These limits remain visible in the
receipt and do not disappear when the local admission constant advances.

## Local mechanism proof

The new `scripts/run-migration-236-247-rehearsal.mjs` constructs exact Git-byte 236/245/247 snapshots and invokes `runDisposableMigration` for every schema transition. Each run creates new named databases, keeps contradictory failures and their ledger entries, and constructs its corrected case independently.

It takes a PostgreSQL custom-format logical backup of a quiescent synthetic 245 fixture, verifies its archive listing and SHA-256, restores into a different fresh disposable database, and compares the entire migration ledger and logical application snapshots before advancing to 247. This validates a local mechanism only. Consult its final retained result for the actual pass/fail state; this document does not assert success independently of that result.

The retained local engine is PostgreSQL 16.15. A local 16.15 dump/restore does not establish compatibility with the actual staging 17.6 archive. Admission requires a verified actual staging backup and a matching restore using compatible PostgreSQL 17 tooling and a separately identified disposable destination.

Preservation means exact logical row values projected onto the predecessor columns, including timestamps and evidence hashes, with explicit assertions for the added defaults. Failed-migration schema comparison covers public columns, constraints, triggers and functions; it does not claim to compare every PostgreSQL schema object. The runner records the selected candidate lock hash but uses the existing installed Prisma runtime through a junction. It does not prove a clean dependency installation from that lock or the complete application candidate. Integration must freeze and verify the final application revision separately.

## Stop and read-back criteria

Stop on unexpected migration names/checksums, incomplete ledger state, changed candidate bytes, table topology mismatch, invalid indexes or constraints, unexpected row/content/timestamp changes, contradiction diagnostics, missing backup evidence or incomplete restoration verification. An interrupted migration reopens the ledger and recovery gate; do not treat an application redeploy as database repair.

The operator must approve a numeric lock and overall deployment budget using the measured rehearsal observations and actual hosted workload. The local lock observation is not a production latency guarantee. Drain writers first; retain backend PID, blocking relation, wait duration, final transaction outcome and error logs. Restore/cutover remains blocked until all concrete hosted receipt fields above are filled and reviewed.

After a successful database change, application rollback means immutable redeployment of a previously admitted compatible revision while retaining the additive schema and evidence. Production migration or restoration needs its separate incident-stop decision.
