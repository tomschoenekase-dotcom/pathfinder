# Staging runbook: operator candidate with migration 255

> **Draft. Nothing here has been run.** It adds the 255 specifics to `docs/staging-release-workflow.md` and `docs/railway-staging.md`,
> which stay authoritative. Every hosted step below is a person's action. Merging into `codex/pathfinder-v2-staging` deploys staging.

## Candidate

- Branch `machine/torchiko/20260930-operator-program`, pushed 2026-10-01. The exact SHA is bound only when Tom names it in writing.
- Migration chain: 255 migrations, manifest SHA-256 `36de18c960796e92e67699fe84958d80a88ba958fbf9b282c88a8236415ae5a0`, 280 public tables.
- Admitted ledger boundaries from this candidate: 254 / 277 (`crm-receipt-predecessor`) to 255 / 280, and the earlier frozen predecessors.
  A ledger at 253, or any divergent or failed row, stops admission.
- Staging image approval name: `torchiko-staging-lineage-to-255-20261001` (names a target; grants nothing).

## Before touching staging

1. Open the PR as a draft from the candidate branch into `codex/pathfinder-v2-staging`; require green `CI`, `visitor-launch`, `railway-iac` on the exact head.
2. From a clean worktree run the release verification for that exact SHA, then
   `pnpm staging:handoff --base-ref origin/codex/pathfinder-v2-staging --candidate <sha> --release-report artifacts/release-verification/<sha>-candidate.json`
   (no network or hosted mutation). Re-run after any change to the candidate or the staging base.
3. Read the current staging ledger (read-only) and confirm it is at the admitted 254 boundary, or at the 252 boundary for the 253 to 255 suffix.

## Preserved-data migration (as in the staging workflow)

1. Pause autodeploy on web, dashboard and workers without deploying. Freeze the SHA. Drain writers.
2. Capture the release-bound backup and its disposable restore proof. A pre-drain archive does not count.
3. Arm only web: `PATHFINDER_ALLOW_STAGING_MIGRATIONS=1`, `PATHFINDER_STAGING_MIGRATION_ONLY_HOLD=1`, `--skip-deploys`. Expect exit 2
   `migration-verified-application-held`. Any other failure stops the run.
4. Verify after the migration: 255 finished migrations, 280 public tables, no invalid indexes or unvalidated constraints, the unique
   `prospect_activities_external_receipt_key_key` index present, `operator_policy_state` holding exactly one row, and the two other new
   tables empty. Row counts and hashes of every pre-existing table unchanged.
5. Close both values to `0`, deploy web code-only at the same SHA, then dashboard and workers after web health passes. Restore autodeploy.

## Flags for the staging check (all default off; set one at a time, record each)

1. `OPERATOR_OAUTH_ENABLED=true` with a staging issuer, a fresh `OPERATOR_OAUTH_PEPPERS` value, and the connector's redirect origin.
2. Connect the connector, call `operator.get_context`, then exercise read tools against staging data.
3. Approve one low-risk proposal (a draft visitor notice) and confirm the audit trail and the canonical row.
4. Leave `OPERATOR_CAMPAIGN_RELEASE_ENABLED`, `OPERATOR_CUSTOMER_CREATE_ENABLED` and `OPERATOR_CUSTOMER_INVITE_ENABLED` off until Tom
   chooses a staging organization and invitee. Create and invite touch Clerk (the invite emails someone); use a staging Clerk instance only.

## Stop conditions

Any ledger mismatch, unexpected table count, unverified backup, red check on the exact head, or an operator path answering when its flag is off.
Rollback is in `docs/operator/release-proposal-operator-crm-20261001.md`.
