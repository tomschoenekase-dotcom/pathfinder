# Venue Deployment Manifest v2 bridge

The local bridge converts a validated, granular Deployment Manifest v2 `PATCH` into the existing
VenuePackage v3 preview or draft input. It does not write data. Callers pass the returned input to
the existing `venuePackage.preview` or `venuePackage.createDraft` procedures, preserving their
tenant scope, manager role, global-AI admission, duplicate analysis, audit, approval, stale-base,
apply, and rollback behavior.

## Exact supported conversion surface

- `UPSERT_IDENTITY`: name and descriptions up to the existing 1,000-character limit.
- `UPSERT_BRANDING`: theme, accent color, and font when no immutable branding assets are present.
- `UPSERT_AI_CONFIGURATION`: guide name and registered tone preset when model references are empty.
- `UPSERT_CONTENT_MODULE`: `PLACE` and `KNOWLEDGE` only. A CUID module ID means update; any other
  stable ID means create. Knowledge bodies retain the existing 5,000-character limit.
- `RETIRE_CONTENT_MODULE`: persisted CUID targets of kind `PLACE` or `KNOWLEDGE` only.
- `RESET_CONFIGURATION`: identity description, branding accent/logo/banner, and guide name only.

The bridge rejects unsupported module kinds, field resets, capabilities/presets, effective-config
provenance operations, immutable asset operations or references, evaluation references, and model
references. Restricted audiences and place parent IDs are also rejected. Module versions and
evidence IDs are reported as explicit delegation warnings because existing content history owns
versions and VenuePackage rows do not retain granular v2 evidence. It never silently discards these
differences. `FULL` manifests are validation-only until a safe
materialization service exists.

The v2 `baseManifestHash` cannot yet be compared because no v2 manifest is persisted. The bridge
reports this explicitly and delegates concurrency safety to the existing VenuePackage preview base
digest and approval-time stale-base checks. The manifest idempotency key becomes the existing
VenuePackage draft key. Existing stored VenuePackage v1-v3 payloads and lifecycle procedures are
unchanged.
