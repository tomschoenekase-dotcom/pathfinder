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
