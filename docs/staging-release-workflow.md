# Torchiko staging release workflow

This is the normal Torchiko feature-delivery path:

1. Create a feature branch from `codex/pathfinder-v2-staging`.
2. Implement and test the feature on that branch.
3. Open a pull request into `codex/pathfinder-v2-staging` and require the `CI` workflow to pass.
4. Merge the feature into `codex/pathfinder-v2-staging`.
5. Railway waits for the branch's GitHub Actions to succeed, then deploys web, dashboard, and workers
   from that commit into the isolated `staging` environment.
6. The `Staging deployment admission` workflow waits for the public health endpoint to report that
   exact 40-character commit SHA and the approved staging database, Redis, and storage resource IDs.
7. Exercise the feature in staging. Record any provider-specific limitations instead of enabling
   production credentials in staging.
8. When the complete staging commit is approved for production, open a pull request from
   `codex/pathfinder-v2-staging` into `master`. The `Production promotion gate` rejects any other
   source branch and rejects a commit that is not the exact healthy staging revision.
9. Merge only after the production database incident stop has been explicitly lifted and the
   release-specific production migration/cutover approval has been recorded. Railway production
   tracks `master`, so merging that pull request is the production application deployment action.

A preserved-data migration uses a controlled exception to step 5. Pause all three application
autodeploy triggers without deploying, freeze the final owner SHA, require its CI success, and
drain writers before capturing the release-bound backup and restore proof. Arm only web with
`PATHFINDER_ALLOW_STAGING_MIGRATIONS=1` and `PATHFINDER_STAGING_MIGRATION_ONLY_HOLD=1` using
`--skip-deploys`. The canonical predeploy verifies migrations and deliberately exits `2` with
`migration-verified-application-held`; this first deployment is intentionally FAILED so its web
application cannot start. Hold applies even to an already-complete ledger. Real migration or
integrity errors remain failures and do not receive the verified-held classification.

After explicit database acceptance, close both values to `0` with `--skip-deploys` and manually
deploy web again at that same SHA for read-only code-only checks. Code-only startup requires
migration opt-in explicitly `0`; an unset hold defaults to `0`, and other hold values are refused.
Release dashboard and dormant workers only after web health passes. Restore autodeploy/CI settings
without deployment after exact three-service admission. Keep the first held receipt separate from
the healthy application receipt, and never use an unresolved cancellation as permission to reopen.
The detailed preservation and recovery gates remain in [the staging runbook](railway-staging.md).

## Exact owner handoff

For a large candidate assembled outside the owner staging branch, generate a deterministic handoff
only after the exact candidate release report passes from a clean worktree:

```powershell
pnpm staging:handoff --base-ref origin/codex/pathfinder-v2-staging --candidate <40-character-candidate-sha> --release-report artifacts/release-verification/<40-character-candidate-sha>-candidate.json
```

The command performs no network or hosted-state mutation. It fails closed unless the candidate is a
strict descendant of the resolved staging base, has no staging-side divergence, matches a clean
`ready-for-staging-review` candidate report, retains an all-default-off centralized feature-flag
surface, and has a readable migration chain. The ignored JSON artifact pins the base and candidate
revisions, delta digests, release-report hash, migration-chain hash, approved non-secret staging
resource identities, required owner actions, and retained production/customer/billing/data gates.
Re-run it after any candidate or staging-base change; never reuse a manifest for another revision.

Release verification writes a secret-free `release-progress` JSON line to stderr when verification
starts, whenever a gate starts or completes, every 30 seconds while a gate is still running, and
when the complete assessment finishes. Each event includes the immutable revision, profile, gate
position, and elapsed time. The final machine-readable summary remains the single stdout line, and
progress reporting never changes a gate result or grants release authority.

## Current service boundaries

- Staging project: `serene-inspiration`
- Staging environment: `a7a394fc-aa4e-4a45-bd3c-904419a67818`
- Staging branch: `codex/pathfinder-v2-staging`
- Marketing site: `https://staging.torchiko.com` (separate site; it does not expose product health)
- Legacy visitor-guide custom domain: retired; Railway fallback retained for recovery only
- Dashboard (canonical after DNS activation): `https://app.staging.torchiko.com`
- Product web and exact-revision health origin:
  `https://staging-web-staging-bbeb.up.railway.app`
- Railway fallback dashboard: `https://staging-dashboard-staging-dc4a.up.railway.app`
- Database resource: `7bd81064-588f-48a5-b138-1fc86691a09b`
- Redis resource: `d53ab235-d403-4d7d-b525-3ace0ef07b92`
- Storage resource: `0a9b3c58-0c9e-47de-96ae-38df297996e8`

The resource IDs are non-secret deployment fingerprints. Credentials stay in Railway or the owning
provider and must never be added to repository files or GitHub workflow logs.

## What is intentionally not automatic

- Production database migrations, restores, resets, and schema/data writes.
- Merging the staging branch into `master`.
- Enabling outbound-provider workers or schedulers.
- Sending real email, using customer integrations, or publishing visitor content.
- Treating Railway's non-versioned bucket as immutable quarantine storage.

These boundaries let routine feature changes deploy automatically to staging while keeping production
promotion explicit and reviewable.

## Domain topology

Torchiko separates the marketing site, venue visitor guide, and authenticated dashboard:

| Environment | Marketing                      | Visitor guide                | Dashboard                          |
| ----------- | ------------------------------ | ---------------------------- | ---------------------------------- |
| Production  | `https://torchiko.com`         | `https://guide.torchiko.com` | `https://app.torchiko.com`         |
| Staging     | `https://staging.torchiko.com` | Retired                      | `https://app.staging.torchiko.com` |

`www.torchiko.com` aliases the production apex marketing site. Existing `*.up.railway.app` domains remain
enabled as recovery origins, but they are not canonical. The staging dashboard intentionally omits
`NEXT_PUBLIC_WEB_URL` while the legacy visitor guide is retired, which suppresses links to that old
experience. In an environment with an approved visitor guide, `NEXT_PUBLIC_WEB_URL` must equal that
guide's origin. Workers' `DASHBOARD_URL` must equal the dashboard origin. DNS and
Railway custom-domain changes are additive and do not authorize a production deployment, migration,
or database write.

The apex and `www` marketing records target the independently deployed Torchiko marketing Site; they
do not route to the product services or database. Registering production `guide` or `app` hostnames
in Railway is not permission to activate their DNS. Keep those product DNS records absent until the
exact staging revision has passed promotion and the production schema is compatible with that
revision. The staging dashboard DNS may be activated independently because it targets the isolated
staging services and resources listed above.

The `workflow_run` admission becomes automatic after this workflow file is present on GitHub's
default branch. It accepts only successful same-repository pushes to the exact staging branch.
Its secret-bearing job checks out the trusted default-branch `github.sha`; the triggering candidate
SHA is used only as the expected deployment identity. Pull requests, forks, and candidate checkout
cannot enter that privileged readback path. This follows [GitHub's workflow-run event contract](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run). Before that first reviewed production promotion, run the same checked-in
`verify:staging-health` command from `railway-staging.md` after Railway reports the staging deployment
healthy. Railway's own health check remains active. Require `Wait for CI` on all three application
services and verify the owner check suite actually completes. That setting does not order web,
dashboard and workers relative to the migration; preserved-data cutovers still use the explicit
held web-only sequence above.
