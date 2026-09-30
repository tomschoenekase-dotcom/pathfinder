# Restricted production cutover approval — 2026-09-30

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

Owner approval: **APPROVED 2026-09-30**, for the exact candidate and limited scope below. Approval is
not permission to skip a gate, substitute a revision, or perform any unrelated production action.
The global database incident state remains ACTIVE by default.

## Owner instruction and bound source

Tom's exact instruction on 2026-09-30:

> So how can you get it the update. That was the whole point of this to get all the features we made live

This authorizes the combined Release B/operator/Safari candidate, limited to migrations 253 and 254
and the application rollout in this record. The approved candidate is source commit
`3ae05f50a864807dc02276a117cbff3a0bcd36cf`, tree `a420fa9ad506b5929285ef29f8ff49629d2e201f`,
represented by [draft production promotion PR #36](https://github.com/tomschoenekase-dotcom/pathfinder/pull/36).
The owner-reviewed cutover-plan digest is
`78981a2d5bb0423b3ff9440f79f48757572afeb03229287a7b17fa7a0b1655fb`. The September 22 approval
remains limited to its distinct 110-to-250 plan.

The owner approval binds this exact application source tree, not future or unrelated code. This
release record and its static-safety test add documentation to the source after that candidate was
staged. The final source SHA containing those approved docs/test changes must receive full green CI
and exact three-service staging admission before master promotion; the final SHA must be recorded in
the promotion evidence and must match the admitted revision. This prevents circularly requiring a
commit hash for the commit that creates this record. No prior candidate's green checks transfer to a
changed source tree.

## Approved database scope and preservation contract

The only authorized database changes are the two pending migrations:

- `20260930100000_add_mcp_venue_appearance_capabilities`
- `20261001090000_add_operator_oauth`

Expected production baseline before the write: 252 finished migrations, 253 physical ledger rows, and 269 public tables.
One exact known rolled-back duplicate exists for
`20260912080000_add_guest_conversation_disposition`; preserve that historical row byte-for-byte.
Expected endpoint: 254 finished migrations and 255 physical ledger rows, with 277 public tables.
The local/isolated rehearsal reached that endpoint with all 268 pre-existing public-table row counts
and hashes unchanged and no pending migration replay. Public invalid indexes and unvalidated public
constraints were zero. A provider-managed Realtime constraint outside `public` is outside this scope
and must not be altered or represented as a public constraint finding.

Backup evidence is deliberately separated. The production rehearsal used a **pre-drain** archive;
it demonstrates a rehearsed migration path but is not a fresh release-bound production recovery point.
A different **staging-only** final archive and restore proof also exist; staging evidence is not
production evidence. Neither archive satisfies the live pre-write backup gate below.

## Required live gates and exact order

1. Require successful full CI and exact three-service staging admission for the final docs-bearing
   source SHA, then confirm PR #36 targets `master` from that exact admitted SHA. Any source change
   restarts these checks.
2. Pause autodeploy on production web, dashboard, and workers without triggering a deployment.
   Confirm production predeploy migrations cannot run automatically. Preserve the original service
   settings for controlled restoration after acceptance.
3. Drain production application writers and background work. Re-read the migration ledger and stop
   unless it still has exactly 252 finished / 253 physical rows and the known rollback row is
   unchanged. Capture a fresh PostgreSQL 17.6 production backup **after the drain**, checksum it, and
   restore-verify it in a distinct disposable database. Verify expected baseline counts and hashes.
   The prior pre-drain production rehearsal and staging backup cannot substitute for this gate.
4. Only after the post-drain backup and restore validation pass, invoke this single allowlisted
   production migration command from the frozen, reviewed release source:

   ```powershell
   pnpm --filter @pathfinder/db db:migrate:prod
   ```

   Inject `DATABASE_URL` and `DIRECT_DATABASE_URL` only through the approved secret environment; do
   not put credential values in arguments, notes, shell history, or logs. Do not invoke the staging
   wrapper, seed, reset, restore over production, or manually replay finished migrations.

5. Keep applications drained while verifying exactly 254 finished / 255 physical ledger rows, the
   byte-preserved historical rollback row, 277 public tables, all 268 existing public-table counts
   and hashes unchanged, no pending replay, zero invalid public indexes, and zero unvalidated public
   constraints. Stop on any ledger drift, backup/restore failure, changed rollback row, count/hash
   mismatch, integrity finding, alarm, or unexpected migration result. Do not repair or clean up data
   under this approval. Do not change provider-managed schemas.
6. After database acceptance, manually release the exact admitted source in this order: visitor-guide
   web, dashboard, then dormant workers. Verify the deployed SHA and health for each service before
   proceeding. Keep workers, provider, scheduler, outreach, billing, dispatch, and execution flags
   disabled. After all three services pass exact-revision health checks, require Wait for CI on all
   three services before restoring autodeploy. A deployment or health failure stops rollout; no
   automatic database restore or unverified application rollback is authorized.

## OAuth and other activation boundaries

Keep `OPERATOR_OAUTH_ENABLED=false` on initial production boot. OAuth activation is a separate,
owner-only follow-up after the database and application release is healthy. It requires verified
production Clerk identity binding and owner login, the exact production issuer, production-only
pepper material, approved redirect origins, an owner-only user allowlist, and Clerk MFA/passkey
re-verification for the one-consent arm/consent flow. Never broaden the allowlist or invite customers
under this approval.

No seed, reset, manual data edit, restore over production, customer email, billing activation,
provider/background execution, scheduler, outreach, or dispatch is authorized. The guest-disposition
maintenance CLI remains parked because its verifier does not support the preserved rollback history
at the 254-migration endpoint; it is not a dependency for ordinary application health.

## Incident boundary

This is a one-time exception for this exact 252-to-254 cutover and bound application source. The
production incident state remains ACTIVE before, during, and after the release by default. Any
unrelated operation, new migration, changed source tree, or changed target is outside the approval.
Preserve all historical incident and September 22 approval records. Do not describe this scoped
exception as incident resolution.
