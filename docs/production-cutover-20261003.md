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

The production migration entrypoint is the external workspace's
`qa/release-migrate-production.mjs`. After explicit owner approval and the complete production
backup/rehearsal gates above, run from that workspace with the approved environment injected by
the operator (never put connection values in command arguments):

```powershell
node qa/release-migrate-production.mjs RELEASE_CHECKOUT FULL_RELEASE_SHA qa/production-fresh-before.json qa/production-migration-receipt.json
```

Use new output names for each attempt. Set `RELEASE_QUEUE_COUNTS_FILE` to current zero-count
evidence; absent evidence is `NOT_PROVEN` and refuses migration. The wrapper requires production
resource identity, exact HEAD, a clean tracked/untracked tree, and the frozen manifest. It runs a
fresh schema-v2 before-readback against that same checkout, then rechecks source identity and the
manifest immediately before Prisma. The readback must be from this invocation, at most 60 seconds
old, and show no application writers. Older v1 readbacks cannot be reused. This wrapper does not
replace drain, backup, restore rehearsal, promotion approval, or the after-migration comparison.

Keep current customer-create/invite, outbound email/notifications, routines and job-grant switches
unchanged. Do not send mail, invite users, perform live billing actions, change identity-provider
users, purchase services or change the GPT-6 Luna setting. Do not force push, bypass a gate, use
admin merge or change branch protection, required checks or CI secrets.

If production fails, pause import/merge writers and restore the previously admitted application
SHA from its verified release record. Keep additive data and receipts; never run a destructive
down migration. App rollback cannot reverse merges or provider effects.

Rollback after the 267 migration has a constraint. The 9f staging predeploy accepts only its own
255-row ledger, so redeploying 9f's web fails predeploy once staging holds 267 rows, and a plain
revert of the PR40 merge fails the same way. Rollback therefore uses the prepared branch
`codex/pr40-staging-rollback-9f-on-267`: 9f application code with this release's 267 schema,
migrations, tenant registry and admission script, deployed code-only (hold 0, migration opt-in 0).
Admit its exact SHA through the same checks before relying on it.

Roll back in this order and stop at the first failure:

1. Pause the workers.
2. Record the BullMQ waiting, active and delayed counts.
3. Set the import and merge writers off.
4. Reset `PATHFINDER_RELEASE_SHA` on all three services to the rollback SHA, or remove it.
5. Deploy web, then require health and the exact SHA.
6. Deploy the dashboard, then the workers, requiring the exact SHA after each.
7. Keep provider switches unchanged.

Prefer redeploying a recorded deployment over a rebuild. Production also builds the dashboard
through the compatibility configurations, which now set the 6 GiB heap for the build only.

Exact candidate/deployment SHAs, backup IDs, migration ledgers, acceptance receipts and rollback
command will be recorded in the release handoff and journal after execution. Until then, hosted
release, physical iPhone, live Gmail bounce/draft behavior and Stripe sandbox are NOT RUN.
