# One-click staging release design (Packet 10)

Status: source proposal. No hosted staging release is authorized by this document.
Base: `512df5d4329ac4842b1c5e3cb9ea6cd92710d324`.

## Sequence and trust boundaries

1. A manually dispatched GitHub Actions run pins a full commit SHA. The default mode is `dry-run`. It uses only an Actions PostgreSQL service container with synthetic rows. It takes a custom-format logical dump, encrypts the bytes, restores into a second disposable database, and checks the migration ledger, bounded table counts, and deterministic content fingerprint. It uploads a short-retention encrypted archive and sanitized evidence.
2. A real staging candidate reads the target database identity and ledger before any write. It compares the recorded Railway database resource ID `7bd81064-588f-48a5-b138-1fc86691a09b`, database OID or system identity, and ledger prefix. A changed identity or missing recorded baseline stops the run. A current read-only baseline must be recorded by Tom before enabling this mode; the historic resource ID alone does not prove the current target.
3. Backup and disposable restore proof complete before the `staging` GitHub Environment approval. Secrets used for that phase must be available only to the trusted workflow on the protected branch. The approval gates migration and deployment. The release stage rechecks target identity, ledger, and source SHA because the target may change while approval is pending. A shared concurrency group serializes staging releases; re-runs that find an unexpected ledger suffix stop for inspection.
4. The held migration wrapper is the only migration entrypoint. Its preserve-existing admission must match the current incident-stop policy and the exact release; a conflict leaves the hosted write disabled. After migration, all three Railway services must report the full same SHA. Public health and journey readbacks follow. The evidence distinguishes a synthetic dry run from a hosted release.
5. Restore is a separate manually dispatched workflow. It creates a new database target, verifies the encrypted artifact and restore, and never overwrites the current hosted database. A cutover would require another explicit approval and a separate plan.

## Threat notes and stop conditions

- **Secrets in logs or artifacts:** mask each secret before any command, turn off shell tracing, send only sanitized structured errors to logs, encrypt the dump before upload, and retain the private artifact briefly. Tests grep captured output for passphrases and URLs. Do not include plaintext SQL, credentials, or customer row content in evidence.
- **Wrong target:** compare independent resource ID, database identity, host/database confirmations, and ledger prefix. URL labels and a `staging` environment name are insufficient. A changed identity blocks writes.
- **Partial migration:** retain the encrypted backup and failed migration evidence. Do not automatically restore over a live target or mark a failed Prisma migration resolved. Resume only when ledger inspection proves an admitted suffix.
- **Concurrent deploy:** use one staging concurrency group and recheck the target after approval. Report all three deployment IDs and full SHAs; mixed generations block admission.
- **Archive retention:** staging encrypted artifact uses short GitHub retention. Record SHA-256 and expiry. Production needs Tom-owned archive storage and a new incident-stop exception; this workflow does not implement production.
- **Cost:** official PostgreSQL client tooling and existing staging resources only; no paid backup plan or added hosted service.

## Current policy conflict to resolve before a real run

`docs/database-incident-stop.md` still describes the staging exception as synthetic-only and says restored production lineage requires release-specific preserve-existing authorization. The planning packet records Tom's preserve-existing direction, but the checked-in fail-closed migration guard must be reconciled with that incident-stop text through a separately reviewed change before any real staging migration. The synthetic dry run can prove the pipeline without crossing that gate.
