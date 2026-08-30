# Torchiko staging current truth — 2026-08-30

> **Migration instruction status: HISTORICAL — DO NOT EXECUTE.**

This is a bounded snapshot of the authorized Railway `staging` environment. It records exact
deployment evidence; it does not authorize production, provider activation, customer contact,
live billing, destructive data work, or deferred marketing/brand/Tochi work.

## Active release

- Git revision: `a82328e5402d3150d43147b25abf0df54e0930b0` on
  `codex/pathfinder-v2-staging`.
- Web deployment: `d0c31034-923b-4dfa-9a45-b6daeb854b9a`.
- Dashboard deployment: `dae224ea-e816-494b-8cf9-b1ef13bc24c0`.
- Worker deployment: `0365952e-4c0b-48a9-9955-59e26a9972d0`.
- Exact-revision GitHub Actions run `33330401052` completed successfully.

All three services were active on the exact revision when this snapshot was retained. The public
health projection reported the reviewed database, Redis, and storage identities with database and
queue status `up`. The authenticated hosted staging profile passed 19/19 with zero failed or
blocked gates.

## Database boundary

- The guarded web pre-deploy accepted the exact Railway target, frozen 206-file migration manifest,
  and exact complete 206-row ledger.
- It applied no migrations. The already-complete path rechecked 206/206 ledger integrity, exactly
  232 public tables, valid public indexes, and validated public constraints.
- The one-run migration flag was returned to `0` without triggering another deployment.
- Railway's branch-triggered web and worker records remained in `WAITING` without associated builds;
  bounded source redeploys created the successful exact-revision deployments recorded above. The
  stale waiting records remain Railway audit history and never replaced the healthy services.
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
  `artifacts/release-verification/a82328e5402d3150d43147b25abf0df54e0930b0-candidate.{json,md}`
  (runtime artifact; intentionally gitignored)
- Staging report:
  `artifacts/release-verification/a82328e5402d3150d43147b25abf0df54e0930b0-staging.{json,md}`
  (runtime artifact; intentionally gitignored)
