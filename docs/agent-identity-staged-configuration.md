# Staged Agent Identity Configuration

PathFinder's Internal Workspace can create and revise agent identity configuration without
activating an agent runtime. This surface is intentionally one-way toward safety:

- a new identity is always created with `enabled = false`;
- an identity can be edited only while it remains disabled;
- an enabled legacy identity can be disabled, but cannot be edited or re-enabled here;
- provider, model, credential, run, retry, and execution controls are absent;
- every mutation requires a human platform administrator and strict audit evidence in the same
  database transaction.

## Exact scope and concurrency

The action contract accepts either an exact client scope (`tenantId`, `venueId = null`) or an exact
venue scope (`tenantId`, `venueId`). Venue creation verifies that the venue belongs to the supplied
tenant. Reads, guarded updates, and the post-update read repeat the full scope tuple; a record with
the same ID in any other tuple is treated as not found.

Edits and disables require `expectedUpdatedAt`. The helper first compares the observed revision and
then repeats it in `updateMany`, together with the exact scope and expected enabled state. A stale
or raced write returns `CONFLICT` and does not write success audit evidence.

## Closed authority vocabulary

Identity type, access capability, autonomy level, and autonomous action are closed contracts in
`@pathfinder/contracts`. Autonomous actions must have their corresponding access capability.
Read-only identities cannot declare autonomous actions; draft identities may declare only draft
preparation. Adding a capability or action therefore requires a reviewed contract change rather
than accepting a free-form string from the editor.

Existing identities that contain legacy values outside the allowlist remain visible in the
read-only operations view. The editor fails closed for those records and explains that a separate
migration is required.

## Verification boundary

Unit and adapter tests cover non-admin rejection, exact tenant/venue and client-only scopes,
cross-scope not-found behavior, allowlist/coherence rejection, stale revisions, enabled edit
rejection, compare-and-swap loss, strict audit failure, and UI payloads. These are local contract
tests only. No migration, live database, provider, credential, Redis, agent run, or deployment was
used to verify this feature.
