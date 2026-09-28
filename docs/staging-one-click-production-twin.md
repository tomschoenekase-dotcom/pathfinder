# Production twin proposal

This is a design note only. Packet 10 does not change `production-promotion.yml`, access production, or authorize a production release.

The production version would retain the same immutable release SHA, independent read-only target identity and migration ledger check, encrypted `pg_dump -Fc` archive, restore into a newly provisioned disposable PostgreSQL database, preservation comparison, held migration, exact-SHA three-service release, and public readbacks. It would store the encrypted archive in Tom-owned storage with a separately approved retention and recovery policy. A short-lived GitHub artifact is only the staging default.

Before any production implementation, `docs/database-incident-stop.md` needs a release-specific exception naming the full SHA, current Supabase project/database identity, admitted ledger suffix and checksums, backup storage owner, restoration proof, writer-hold mechanism, rollback/forward-repair decision, spend bounds, and Tom's explicit approval. The 2026-09-22 exception covered the earlier 110-to-250 cutover; it does not admit migrations 251–252 or a future release. The production workflow would remain disabled until those facts and provider permissions are verified independently.

Production secrets belong in a protected GitHub Environment or Tom-owned secret store, never in repository files or artifacts. A pre-approval backup phase would need its own explicit authorization design; production database reads cannot be inferred from a workflow trigger. A restore workflow would create a new database and stop before any cutover, preserving the live target and its backup history.
