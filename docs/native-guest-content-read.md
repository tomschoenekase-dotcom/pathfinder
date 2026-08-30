# Native guest content read executor

The native guest content executor is implemented but disabled by default. It does not activate from
one boolean. A request uses the native snapshot only when all of these gates pass:

1. `NATIVE_GUEST_CONTENT_READ_ENABLED=true` in the intended environment.
2. An enabled tenant feature flag with the exact key
   `native-guest-content-read-v1:<venueId>`.
3. Strict flag metadata with `schemaVersion: 1`, the same `venueId`, mode `DARK` or `ACTIVE`, the
   exact target release and evaluation-evidence UUIDs, and non-empty quality-policy and rollback-
   rehearsal references.
4. The target is the exact applied native head and its immutable desired-state hash validates.
5. The referenced evaluation evidence is `PASS` and matches the tenant, venue, release, artifact,
   manifest, and desired-state hash.
6. Production additionally has a non-empty `productionApprovalRef`. Staging does not imply that
   approval.

`DARK` validates the complete gate chain but keeps the compatibility result. `ACTIVE` replaces
authorized/ranked place and knowledge values with the exact immutable native-head values. The
legacy query remains the visibility authorization and ranking index because `NATIVE_CORE_V1` does
not encode `PUBLIC` versus `SECOND_LAYER`. Any missing authorized ID causes whole-request fallback;
the executor never produces a mixed native/legacy result.

## Rollback

Disable the exact venue flag or set `NATIVE_GUEST_CONTENT_READ_ENABLED=false`. The next request uses
`LEGACY_SEMANTIC_PLUS_NATIVE_GENERALIZED_PROMPT`; no data migration or service restart is required
when environment configuration supports runtime updates. Compatibility rows must remain available
while this executor depends on their authorization and semantic index.

This mechanism does not authorize staging or production activation, does not establish a quality
threshold, and does not create production release approval. Those references must point to genuine
reviewed evidence; placeholder values are policy violations even though their shape is valid.

## Read-only activation preflight

Platform administrators can query `admin.getNativeGuestReadActivationPreflight` for one exact
tenant and venue. The response combines the authoritative runtime read-gate assessment with the
existing native-head convergence measurement. It reports server and venue gates, strict policy
validity, target-head identity, exact passing evaluation evidence, evidence-reference presence,
production-approval requirements, compatibility retention, and observed blockers.
Runtime-read and materialized-convergence evidence remain separate and are also summarized by an
explicit alignment projection so an immutable PASS cannot hide mutable state drift.

The preflight is diagnostic only. It never changes environment configuration, feature flags,
deployment state, evaluation evidence, or guest traffic. A populated reference proves only that a
strictly shaped reference exists; the preflight does not invent or certify a quality threshold,
rollback policy, or production approval. State hashes and immutable plan bodies are not returned by
the admin projection.

Authorized operational AI can observe the same alignment through the existing MCP
`pathfinder.read` readiness resource. The credential must have both `resources:read` and
`readiness:read` plus the exact client and venue scope. Its `nativeGuestRead` projection exposes
only gate/policy validity, reference-presence booleans, head/evaluation validity, path, reason,
blockers, and convergence alignment. It never returns release or evidence identifiers, reference
strings, state hashes, or production-environment identity. The projection is read-only and cannot
authorize activation, infer a quality threshold, or relax compatibility-data retention.
