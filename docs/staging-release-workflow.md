# PathFinder staging release workflow

This is the normal PathFinder feature-delivery path:

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

## Current service boundaries

- Staging project: `serene-inspiration`
- Staging environment: `a7a394fc-aa4e-4a45-bd3c-904419a67818`
- Staging branch: `codex/pathfinder-v2-staging`
- Public web: `https://staging-web-staging-bbeb.up.railway.app`
- Dashboard: `https://staging-dashboard-staging-dc4a.up.railway.app`
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

The `workflow_run` admission becomes automatic after this workflow file is present on GitHub's
default branch. Before that first reviewed production promotion, run the same checked-in
`verify:staging-health` command from `railway-staging.md` after Railway reports the staging deployment
healthy. Railway's own health check and its `Wait for CI` setting remain active throughout.
