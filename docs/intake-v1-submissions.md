# V1 onboarding submissions

A V1 submission freezes an explicit set of onboarding sources for review. It has a stable identity and append-only revisions. Saving a V1 does not run website research, invoke a model, build a venue package, approve content, or publish to visitors. Its current state is `AWAITING_CANONICAL_REVIEW`.

## Submit and amend

The tenant intake API exposes `submitV1`, `amendV1`, `getV1`, `getLatestV1`, `listV1Candidates`, and `listV1UploadCandidates`. Tenant managers and owners use their authenticated user identity; callers cannot supply a different owner. Current human roles are tenant-wide, while each source selection is fenced to the exact tenant, venue, and owner.

An initial request supplies an operation UUID, selected private draft kinds with their expected revisions, explicit source/upload IDs, and an optional partial-submission acknowledgement. The combined selection is limited to 50 members. Valid private drafts become canonical intake proposals inside the same real transaction as the V1 revision. A failed aggregate write rolls back those proposals and leaves the private drafts unsubmitted.

Amendments require the aggregate ID and its expected current revision. Every new revision is a **full replacement selection**. A caller adding one source must carry forward the previous members it wants to retain. The client read model returns `FULL_REPLACEMENT` and safe labels for those members. A stale aggregate or draft revision conflicts; partial acknowledgement does not override stale draft revisions.

Exact operation retries return the historical revision belonging to that operation, even after later amendments or changes to private drafts. Changing the selected material, owner, venue, acknowledgement, or amendment target under the same operation conflicts. A tenant-scoped operation lock precedes replay under READ COMMITTED; an amendment then locks its exact owned aggregate before checking the revision.

## Source and privacy boundaries

Existing sources must be human-owned canonical intake runs with an input hash. Selected uploads must belong to the same owner and have a CLEAN malware receipt matching the exact object generation, SHA-256, byte size, and storage version. Selected runs, uploads, and receipts stay locked while the immutable member snapshot is written. Selecting both an upload and its linked run is rejected.

Only the active staff-interview role is materialized. The canonical consent, question set, and privacy rules apply; retained text in skipped or redacted answers is not shared. Incomplete private drafts and ineligible sources may be omitted only when the caller explicitly acknowledges a partial submission. The receipt identifies omissions. At least one eligible member is required.

The manifest retains source identities and hashes rather than raw draft content or storage object keys. Database constraints enforce tenant/venue references, at most 50 ordinal positions, unique members within a revision, immutable aggregate identity, and append-only revision/member records. The service uses deterministic ordering for request and manifest hashing.

## Resume and downstream work

`getLatestV1` discovers the latest owned submission after reload. Revision reads return at most 20 revisions per page, with safe member labels. Source and upload candidate lists use separate bounded cursor pages, at most 50 items each. List results are candidates; final eligibility is checked again on submission.

The client onboarding workspace flushes pending private draft saves before opening an explicit selection review. Editing pauses while that snapshot is reviewed. Amendments retain the previous selected members, including those outside the first candidate page; a linked upload and its source cannot both be selected. New selections and partial acknowledgements receive a new operation UUID.

An uncertain response keeps the same operation UUID and exact selected IDs/revisions in owner-and-venue-scoped session storage. Reload restores that retry before allowing edits. No raw draft text is placed in this retry record. Client, owner, venue, and unmount changes fence late responses. The protected server page supplies the authenticated owner namespace; it does not grant API access through a browser prop.

After a confirmed save, the workspace reloads the exact returned revision using the bounded revision cursor, even when a later amendment already exists. A receipt-read failure still reports the confirmed save and refreshes the private draft workspace. It does not invite an accidental second submission under the pre-save draft revision.

Canonical review and package-building integration remain separate work. The presence of a V1 receipt is not evidence that generation has started or that a visitor-facing artifact exists.

The retained [native PostgreSQL journey](evidence/intake-v1-native-postgres-2026-09-07.json) passed through 224 fresh migrations and 251 public tables in UTC. Focused source-snapshot tests additionally reject mismatched receipt generation, SHA-256, byte size, and storage version before aggregate writes. These are local fixture proofs, not provider or deployment evidence.

The [coordinated client browser proof](evidence/intake-v1-client-browser-2026-09-07.json) covers private draft flushing, explicit review, confirmed receipt read-back, reload and exact retry after a lost response at phone/tablet/desktop widths. Narrow320px keyboard, accessibility and overflow checks are retained. It uses synthetic transport; it is not hosted or provider evidence.
