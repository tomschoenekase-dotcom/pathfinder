# PR40 release scope — October 3, 2026

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

The owner authorized non-force branch delivery, exact-head CI repair, the reviewed admission of
only migrations 256–267, staging release and protected production promotion on October 3.
This scope supersedes the review-first pause for PR40. Prior release records remain historical.
Authorization does not establish that any acceptance or preservation gate has passed.

The reviewed suffix begins at `20261002090000_add_live_data_connectors` and ends at
`20261002121000_prospect_organization_merge`. The complete LF-normalized 267-migration manifest
is `cbad930003f17d1953495a8d477a64b138b55db29022632aa20b93b2b8af2e00`.
The 255 prefix stays frozen at `36de18c960796e92e67699fe84958d80a88ba958fbf9b282c88a8236415ae5a0`.
The reviewed predecessor has 255 finished migrations and 280 public tables; the endpoint has
267 finished migrations and 297 public tables. Preserve every physical ledger row, including
the historical rolled-back duplicate. The production incident remains ACTIVE by default.
All earlier predecessor freezes and refusals remain mandatory; partial suffixes are inadmissible.
No new migration, venue-timezone change or pending documentation-name replacement is authorized.

Follow `staging-release-workflow.md`, `railway-staging.md` and the existing three-service sequence.
Require all checks green on the exact candidate; freeze its full SHA before any hosted mutation.
Drain writers before the release-bound backup. Restore privately to a disposable database, rehearse
the twelve migrations and compare original-table counts and original-column hashes. Verify ledger,
indexes, constraints, credential capability ordering and the disabled/empty new-table invariants.
Without a proved restorable backup, stop for owner action. Never attest unverified backup fields.
Use local PostgreSQL 17 for the public-schema rehearsal. The complete private archive retains
ownership and privileges; record local ownership/ACL remapping. This rehearsal does not claim
a complete provider-platform restoration. Preserve the historical weekly-digest checksum only
with its canonical schema fingerprint passing. No seed, reset, restore over production or staging,
or manual data cleanup is authorized.

Use the staging web-only migration hold, require its verified-held exit 2, close both migration
controls to 0, then release web, dashboard and dormant workers at the same source in that order.
Require health and exact-SHA admission. Record phone-width early typing, Send/Stop, CSV
stage/commit/replay, merge preview/approval, mail reconciliation/draft counts, operator and billing.
Promote only from `codex/pathfinder-v2-staging` to `master` through the protected promotion gate.
Repeat the independent production drain, backup, restore/rehearsal and preservation checks before
the existing production migration entrypoint and three-service release.

Keep current customer-create/invite, outbound email/notifications, routines and job-grant switches
unchanged. Do not send mail, invite users, perform live billing actions, change identity-provider
users, purchase services or change the GPT-6 Luna setting. Do not force push, bypass a gate, use
admin merge or change branch protection, required checks or CI secrets.

If production fails, pause import/merge writers and restore the previously admitted application
SHA from its verified release record. Keep additive data and receipts; never run a destructive
down migration. App rollback cannot reverse merges or provider effects.

Exact candidate/deployment SHAs, backup IDs, migration ledgers, acceptance receipts and rollback
command will be recorded in the release handoff and journal after execution. Until then, hosted
release, physical iPhone, live Gmail bounce/draft behavior and Stripe sandbox are NOT RUN.
