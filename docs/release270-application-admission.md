# Release270 staging application admission

This is a read-only code-deployment gate, separate from the manual schema runner.
It supports only the three existing staging service IDs in
`scripts/lib/staging-release-admission.mjs`. It grants no migration authority,
changes no flags, starts no workers and makes no deployment. Historical267/269
guards and migration SQL are unchanged. Docker/config wiring is not included.

Run the packaged `node /admission/scripts/run-release270-staging-predeploy.mjs`
with no arguments. Linux, provider Git SHA and strict explicit migration-opt-in0 /
migration-only-hold0 are required. Local upload identity fallback is intentionally
unsupported. Project/environment/service/database/Redis/storage identities and
private database host/port/name must match the reviewed receipt. Existing injected
DB authentication stays in-process; no URL or raw row is printed or written.

## Immutable image inputs and independent trust

The future packaging owner must build from an independently verified clean exact
checkout with frozen dependencies and generated Prisma client. Preserve the full
import closure of the packaged scripts; importing current target/manifest modules
also requires their existing transitive modules. Keep source-relative paths under
`/admission`, including packages/db/package.json, Prisma runtime dependencies, all
270 migration files, schema.prisma and pnpm-lock.yaml. The app image does not need
Git or a migration CLI. The fixed app engine override, if present, is restricted to
`/app/prisma-engine/query-engine.node`; Node/other engine overrides are refused.
The actual CLI and imported admission library URLs must resolve to their fixed
`/admission/scripts/` locations. An alternate executable cannot validate a separate
good source copy. The seal inventory includes all eleven current relative-import
JavaScript modules plus schema.prisma and pnpm-lock.yaml; a closure test rejects
new relative dependencies that have not been added to that inventory.

Three private artifacts are required at the fixed paths below. No runtime
generator is provided. Do not derive a purported independent reference from the
currently observed DB or create a successful receipt from asserted booleans.

- `/admission/release270-image-seal.json`: schema
  `torchiko-release270-application-image/v1`, full releaseSha, exact manifestHash,
  independently recorded trackedSourceArchiveSha256, receiptSha256, referenceSha256
  and files mapping the exact APPLICATION_SOURCE_FILES inventory to raw-byte hashes.
- `/admission/release270-reference.json`: independently reviewed full270 catalog
  on the actual PostgreSQL major/roles/default privileges. Its raw file hash is
  pinned by the seal; its canonical catalog hash is pinned by the release receipt.
- `/admission/release270-application-release.json`: schema
  `torchiko-release270-application-release/v1`; exact staging environment,
  projectId/environmentId/resources, databaseHost/databasePort (string), releaseSha,
  referenceReleaseSha, manifestHash, catalogHash, postgresMajor16 or17; phase verified,
  state complete270, applicationReleaseApproved true, independentRestoreVerified true;
  migrationJournalSha256, backupSha256, restoreProofSha256, independentReviewSha256,
  physicalLedgerHash, newSecurityHash, existingSecurityHash, policyHash,
  reconciledZeroStepRows; canonical ISO completedAt, approvedAt and expiresAt.

The receipt is a separately reviewed application-release decision after actual
schema execution, backup/restore/security proof and journal reconciliation. It is
not the migration runner's current output schema. Review the conversion against
original evidence; no adapter is supplied. Ledger/security hashes use the existing
release270 collector's exact JSON layout; physicalLedgerHash hashes its ledger
array, including physical rowHash/native timestamp text and retained zero-step rows.

An independently reviewed deployment configuration must pin the raw image-seal
SHA256 in PATHFINDER_RELEASE270_IMAGE_SEAL_SHA256. Do not calculate that value from
the image's own seal at startup. Bind the seal/clean-checkout build to the actual
deployed image digest with external provenance/topology verification. Runtime
checks verify source-file/schema/lock bytes and exact270 migration manifest, but
cannot prove a Git ancestry or all unlisted app/dependency bytes in a standalone
image. The archive hash names external proof; it is not locally reconstructed.

## Read-only behavior and rollout limits

The collector uses one RepeatableRead transaction, READ ONLY first, server statement
timeout10s, lock timeout2s, idle transaction timeout15s, Prisma total timeout20s and
max-wait5s. CLI connection/pool timeouts are5s with one connection. It reads complete
physical ledger, full existing270 catalog and security/ACL/RLS/defaults/type grants;
the exact receipt/reference and fresh readback must match. It never filters failed,
extra, rolled-back or unreconciled zero-step rows to obtain acceptance. DB roles and
extension behavior beyond current catalog/security collection remain external proof.

Normal content writes, active sessions, queues and sequence values are allowed;
those mutable values are deliberately not compared at app startup. Schema, ledger
and security changes still require another reviewed release. Controls/source are
rechecked after readback. Disconnect errors fail the gate; output is finite identity
and admission status only. No migration/spawn/reset/repair/apply operation exists.

Approval must follow completion and precede now; expiry must follow approval and
be within24h of completion. Expired receipts fail even on a later redeployment or
restart using this gate; obtain a fresh independently reviewed artifact/config seal.
This fail-closed availability tradeoff needs operational planning before wiring.
There is no indefinite-validity policy or automatic renewal. A new expiry requires
re-reviewed evidence and rebuilding/resealing the immutable receipt inputs. Merely
editing an environment timestamp or replaying the expired receipt cannot renew it.

After actual schema270 proof and approved0/0 transition, deploy/verify required
workers first, then web/dashboard; run trusted same-SHA topology/health plus model
and visitor acceptance. This gate checks one service at a time and does not prove
worker-before-API ordering or worker capability. Predeploy runs separately from the
app and cannot reuse SSH temporary files or mounted volumes. All inputs must be in
the immutable image. Current old269 predeploy still blocks270 until wiring is reviewed.

Unit tests use explicitly fictional catalogs/seals/receipts to exercise refusal and
the read-only SQL boundary. They are not hosted DB, real recovery, image packaging,
runtime provenance, credential or deployment evidence. Production is always refused.
