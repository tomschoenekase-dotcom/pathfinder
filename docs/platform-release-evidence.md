# Platform release evidence

Torchiko retains release assessment as platform state instead of leaving the only trustworthy copy
in one worktree. The canonical record is append-only evidence for one exact Git revision. It is not
a release request, approval, deployment, migration, customer communication, or billing action.

## Evidence path

1. Run `pnpm verify:release -- --profile candidate` on a clean exact revision.
2. Run `pnpm staging:handoff` when an owner-reviewable staging handoff is appropriate.
3. Project those artifacts without credentials or network access:

   ```powershell
   pnpm release:evidence:prepare -- --assessment artifacts/release-verification/<revision>-candidate.json --handoff artifacts/staging-handoff/<revision>.json
   ```

4. A platform administrator may record the payload through `admin.recordReleaseEvidence`. A
   separately activated platform worker may submit the same payload to
   `POST /api/platform-worker/release-evidence` with `action: "record"` and the exact
   `release-evidence:record` capability.
5. Founder Control Room and a `release-evidence:read` worker read the same bounded canonical rows.

The projection command is read-only and prints JSON. It rejects repository-external paths,
revision/cleanliness/readiness/count mismatches, and a handoff whose embedded assessment SHA-256
does not match the exact assessment bytes. Its UUID is deterministic for the two artifact hashes
and source reference, so an identical retry is replay-safe.

## Integrity and authority

`PlatformReleaseEvidence` binds the assessment profile, generated time, exact revision, repository
cleanliness, named gate outcomes, known limitations, rollback instructions, staging lineage,
migration-chain identity, source reference, content hash, actor, and credential when applicable.
Database triggers reject update, delete, and truncate. Exact operation replay and identical-content
deduplication are safe; an operation ID reused for different content fails closed. Recording and
machine reads require strict audit persistence.

A staging-ready handoff is invalid unless its assessment is `ready-for-staging-review`, the
repository is clean, and every supplied gate passes. The response always states that staging and
production deployment, production migration, customer contact, live billing, and valuable-data
destruction are unauthorized.

## Verification

- Contract validation: `packages/contracts/src/release-evidence.test.ts`
- Projection/linkage: `node --test scripts/release-evidence-payload.test.mjs`
- Domain action and migration contract: `packages/db/src/helpers/platform-release-evidence*.test.ts`
- Fresh PostgreSQL lifecycle: `pnpm test:platform-release-evidence:disposable`
- Machine boundary: `packages/api/src/platform-worker-policy/release-evidence-http.test.ts`
- Founder UI and accessibility: `apps/dashboard/components/admin/ReleaseEvidenceSummary.test.tsx`
- Real-browser responsive fixture: `apps/dashboard/tests/visual/core-surfaces.spec.ts`

Hosted staging persistence and deployment remain separate evidence. No credential is issued or
activated automatically.
