# Torchiko staging current truth — 2026-08-30

This is a bounded snapshot of the authorized Railway `staging` environment. It records exact
deployment evidence; it does not authorize production, provider activation, customer contact,
live billing, destructive data work, or deferred marketing/brand/Tochi work.

## Active release

- Git revision: `402de1e02f968b5196caa0a4996b2a762652c186` on
  `codex/pathfinder-v2-staging`.
- Web deployment: `167f664f-a319-4f4f-b348-b5ddb159aa01`.
- Dashboard deployment: `17dc09d0-dd7b-4556-96e0-918a30cbea42`.
- Worker deployment: `96688ea2-f1ec-4a25-bdc3-a0017ed6286b`.
- Exact-revision GitHub Actions run `33324117732` completed successfully.

All three services were active on the exact revision when this snapshot was retained. The public
health projection reported the reviewed database, Redis, and storage identities with database and
queue status `up`. The authenticated hosted staging profile passed 19/19 with zero failed or
blocked gates.

## Database boundary

- The guarded web pre-deploy accepted the exact Railway target, frozen 206-file migration manifest,
  and exact 205-row predecessor.
- It applied only `20260830165000_add_prospect_inbound_reply_reviews`.
- The final ledger and integrity verification passed 206/206 against 232 public tables.
- The one-run migration flag was returned to `0`. A redundant deployment created while closing the
  flag was aborted before pre-deploy; the active web deployment above remained online.
- The service-level approval token is pinned to this exact 206-file release and fails closed on
  release or manifest drift.

## Proven configuration ownership

For this exact release, Railway used the service-specific dashboard, web, and worker build/runtime
configuration. The web migration ran in Railway's separate pre-deploy runtime. That runtime did not
inherit the Docker image's `ENV`, so the exact non-secret migration approval also had to be present
as a web service variable. The checked-in verifier and runbook now model that topology explicitly.

This evidence does not establish that every historical or future Railway release uses an identical
topology. It also does not prove provider-backed model quality, physical-device behavior,
authenticated pixel review, backup/PITR recovery, production state, or any externally gated action.

## Related exact evidence

- `docs/railway-staging.md`
- `docs/staging-release-workflow.md`
- `docs/inbound-reply-continuity.md`
- Candidate report:
  `artifacts/release-verification/402de1e02f968b5196caa0a4996b2a762652c186-candidate.{json,md}`
  (runtime artifact; intentionally gitignored)
- Staging report:
  `artifacts/release-verification/402de1e02f968b5196caa0a4996b2a762652c186-staging.{json,md}`
  (runtime artifact; intentionally gitignored)
