# V1 onboarding submissions

A V1 submission freezes an explicit set of onboarding sources for review. It has a stable identity and append-only revisions. Saving a V1 atomically records per-member processing dispatches. Website research runs only when its dedicated worker policy is enabled; saving does not invoke a model, build a venue package, approve content, or publish to visitors. Its current state is `AWAITING_CANONICAL_REVIEW`.

## Submit and amend

The tenant intake API exposes `submitV1`, `amendV1`, `getV1`, `getLatestV1`, `listV1Candidates`, `listV1UploadCandidates`, and `getV1Processing`. Tenant managers and owners use their authenticated user identity; callers cannot supply a different owner. Current human roles are tenant-wide, while each source selection is fenced to the exact tenant, venue, and owner.

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

Canonical review and package creation are separate explicit operations, described below. The presence of a V1 receipt is not evidence that generation has started or that a visitor-facing artifact exists.

The retained [native PostgreSQL journey](evidence/intake-v1-native-postgres-2026-09-07.json) passed through 224 fresh migrations and 251 public tables in UTC. Focused source-snapshot tests additionally reject mismatched receipt generation, SHA-256, byte size, and storage version before aggregate writes. These are local fixture proofs, not provider or deployment evidence.

The [coordinated client browser proof](evidence/intake-v1-client-browser-2026-09-07.json) covers private draft flushing, explicit review, confirmed receipt read-back, reload and exact retry after a lost response at phone/tablet/desktop widths. Narrow320px keyboard, accessibility and overflow checks are retained. It uses synthetic transport; it is not hosted or provider evidence.

## Durable member processing

Migration 225 adds one immutable-identity processing record per newly submitted member, in the same transaction as the source snapshot. Existing revisions are not silently backfilled. Staff answers and structured notes are ready for canonical review; files without an executable extraction path remain held. These states do not approve material.

Website members use the existing bounded canonical research service. The default-off `INTAKE_V1_WEBSITE_RESEARCH_WORKERS_ENABLED` flag gates startup, queue recovery, and execution. Work is limited to four pages, depth one, one megabyte per page, 30 seconds, and eight engineering cost units. A matching retained research receipt is reused; a prior unsuccessful receipt remains held.

A database lease serializes processing of the same canonical website across revisions while independent sources can progress. Each dispatch keeps one operation ID and permits at most three attempts. Recovery checks retained receipts after an expired final attempt rather than granting a fourth attempt. Exact lease, source hash, scope, and database-clock checks fence preflight and completion. An uncertain transport result is not proof that no research occurred.

BullMQ carries opaque dispatch IDs. Completed and terminally failed wakeups are removed so the durable database recovery scan can enqueue another wakeup when needed; processing history remains in PostgreSQL. The scan discovers at most 25 eligible records per cycle.

`getV1Processing` reads the exact owned submission revision and at most 50 members, exposing safe labels and processing states only. Disabled website work and historical unscheduled members have distinct states. Material processing completion never means that a package or publication exists.

The retained [processing PostgreSQL proof](evidence/intake-v1-processing-native-postgres-2026-09-07.json) passed 225 migrations and a 252-table UTC catalog, including atomic rollback, source serialization, receipt inheritance, and exhausted-lease recovery. The [Redis wakeup proof](evidence/intake-v1-redis-wakeup-2026-09-07.json) passed completed and failed wakeup removal/re-enqueue against isolated Redis. Both services were stopped after proof. Neither fixture calls a research provider or deploys the worker.

## Exact revision to canonical package draft

The admin intake API exposes `previewIntakeV1Package` and `createIntakeV1PackageDraft`. Preview requires an exact submission, revision, and explicit member selection; it returns remaining members and a separate source-lineage candidate hash and canonical payload hash. The read-only MCP tool `pathfinder.preview_intake_v1_package_draft` exposes the same server-derived preview to a venue-scoped `packages:read` credential.

Supported reviewed structured and interview sources use the existing canonical candidate builders. Selected pending, held, or unmapped material prevents that selection from producing a draft. Unselected material remains visible, and partial acknowledgement is required for excluded members or omissions already recorded by the submission. A waiting source does not stop independent processing. Website mapping and optional-note selections enter through the explicit source review below; this boundary does not silently convert unreviewed material into public facts.

The draft command binds the operation UUID, exact manifest, candidate and payload hashes, selected member IDs, actor, and partial acknowledgement. It creates a canonical `VenuePackage` through the existing semantic-review service. Its transaction rebuilds the source projection before inserting the append-only `IntakeV1PackageHandoff`. The receipt allows one package per immutable revision, and one revision per package; later additions require an explicit submission amendment. No duplicate content store is introduced.

Historical retries resolve the retained handoff before recomputing potentially changed review sources. Exact retries can recover a package after its later lifecycle changes; mismatched identity conflicts. A uniqueness or serialization race returns a conflict, and callers retain the operation UUID. Package approval, application and publication use their existing distinct policies. The machine proposal and approval-backed draft adapter below uses this same canonical transaction.

The [native revision-package journey](evidence/intake-v1-package-native-postgres-2026-09-07.json) passed 226 migrations and 253 public tables in UTC. It exercises real canonical source submission, partial acknowledgement, independent pending material, injected handoff failure with package rollback, concurrent exact retries, one-package readback, scope checks and database immutability. Embeddings are deterministic fixture adapters; no provider or hosted action is claimed.

## Reviewed website and optional-note projections

Migration 227 adds append-only `IntakeSourceMappingReview` records. The admin intake operation `reviewIntakeSourceMapping` binds an operation UUID, exact tenant/venue/source input hash, rationale, and the authenticated reviewer. Callers cannot inject the reviewer identity.

For `WEBSITE_MAPPING`, supply the retained research receipt, expected research hash, and explicit canonical website mapping selections. For `OPTIONAL_NOTES_SELECTION`, supply explicit `consentToPublicUse: true`, title, category, and 1 to 20 ordered, nonoverlapping Unicode code-point ranges. Notes must originate from the human-authored optional-notes source; ranges retain exact text rather than inventing a paraphrase. Website projections preserve the original source actor and model provenance while recording the human reviewer separately.

The source is locked while the canonical projection, derived reviewable intake run, evidence, and immutable review are recorded in one transaction. A failed review leaves no derived run. Exact retries return the retained review; changed terms conflict. Source/research/selection/payload hashes and scoped database references protect lineage. The derived run uses `SOURCE_MAPPING_REVIEW` as its projection reference and remains `AWAITING_REVIEW`. Select that derived source in an explicit V1 revision to make it eligible for package preview. The review creates neither a package nor visitor publication.

The [source-mapping PostgreSQL proof](evidence/intake-source-mapping-native-postgres-2026-09-07.json) covers both projections, exact retries, scope/hash/receipt rejection, database immutability, injected rollback, and their integration into a ready V1 candidate through 227 migrations and 254 public tables.

## Agent proposal and approved draft execution

The MCP registry exposes these operations:

| Operation                                    | Capability                                    | Effect                                                                                  |
| -------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `pathfinder.preview_intake_v1_package_draft` | `packages:read`                               | Returns the server-derived exact candidate and hashes.                                  |
| `pathfinder.propose_intake_v1_package_draft` | `packages:draft`                              | Records an immutable approval request; creates no package.                              |
| `pathfinder.apply_intake_v1_package_draft`   | `packages:draft` plus an exact approval grant | Creates the canonical DRAFT and immutable V1 handoff atomically with grant consumption. |

Preview first. Retain the returned manifest, candidate, payload, and selection hashes, the exact ordered member IDs, revision, and partial acknowledgement. Proposal and execution require the current assigned worker, agent identity/run, and workflow execution lease. Keep `draftOperationId` stable across proposal, approval, execution, and retries. The proposal `operationId` identifies its approval request; the execution `operationId` identifies grant consumption. Reuse each operation ID only with its original terms.

A human administrator records the decision through `decideIntakeV1PackageDraftProposal`. An approved decision and the one-shot grant are written in the same real database transaction. The decision itself never starts execution. The grant binds the candidate identity, selected members, revision, and draft operation; it does not authorize package approval, application, or publication.

Execution rebuilds the canonical candidate, checks exact approved parameters, and locks the run-assigned worker, current credential, identity, and scope. Database time is sampled after locks and again after grant consumption, so expired authority cannot survive a lock wait. The grant, package, audit, and handoff roll back together if finalization fails. An exact retry returns the retained handoff at the package's current lifecycle status, with no new effect; changed terms conflict. An uncertain response must be retried with the same identities, not a newly invented operation.

The [machine PostgreSQL journey](evidence/intake-v1-machine-native-postgres-2026-09-07.json) proves assigned-worker proposal admission, human decision/grant, actual machine draft execution, exact replay, grant/package rollback, and stale-credential rejection through 227 migrations and 254 public tables. The [grant expiry race proof](evidence/approval-grant-expiry-native-postgres-2026-09-07.json) retains both the failing pre-fix lock-wait case and the passing post-lock database-clock check. These local fixtures invoke no provider or publication.

The [active-workflow machine PostgreSQL proof](evidence/intake-v1-machine-workflow-native-postgres-2026-09-08.json) extends that journey with a canonical task and assigned execution claim under an immutable `SELECTED` workflow binding requiring both `packages:draft` and `agent-runs:execute`. A negative control proves that truncating the capability inventory fails the real database guard; proposal, approved draft execution, replay, rollback, and credential revocation then pass with the full inventory. Its initial reviewed activation lineage is explicitly synthetic fixture data, so this proves workflow admission rather than promotion or activation approval. All 227 migrations and the test passed, and the disposable PostgreSQL service was stopped.

## Held delivery preparation evidence

The [connected delivery fixture](evidence/intake-v1-delivery-native-postgres-2026-09-07.json) runs canonical collection, V1 freeze, candidate preview, draft handoff, review preview, CORE evaluation preparation, portal read, and billing read in a fresh 227-migration database. It proves exact retries, stale/scope rejection, and that an unreleased inactive venue remains held. Its eight local operation timings are synthetic measurements, not production SLOs.

That fixture does not approve or apply content, activate billing, scan a QR code, or send an invitation. Invitation preparation is explicitly untested because the fixture has no prospect CRM lineage. The fixture leaves billing unconfigured and visitor preview unavailable; these are truthful held states rather than a claim of complete delivery.
