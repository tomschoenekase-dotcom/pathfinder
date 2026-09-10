# Explicit semantic conflict resolution

The operator answer is coordination evidence, not approval or verified venue truth. `admin.resolveSemanticConflict` closes one exact lower-authority conflict with an explicit human decision. It records hashes and references to the retained answer rather than copying a hidden transcript.

## State transitions

- The original targeted proposal must still be APPROVED and reproduce the exact conflict preview. The question must be ANSWERED with the exact operation, timestamps, answer hash and callback binding.
- KEEP_CANONICAL records the decision and retires the original proposal as REJECTED. It creates no replacement.
- PROPOSE_REPLACEMENT records the original conflicting desired state separately from explicitly edited replacement content. It retires the original and creates one HUMAN-authored PENDING_REVIEW proposal. Original support lineage remains through the immutable resolution-to-original-proposal relation; duplicating the original support-version unique key is prohibited.
- A replacement remains blocked before its separate human review. Once approved, the preview service can honor the explicit adjudication only for the exact relation, replacement desired state, answered evidence and unchanged canonical snapshot. The source authority label remains TRUSTED_PARTNER; this is an operator decision, not a new claim of venue verification.
- Existing package/universal-content draft, adoption, approval and publication gates still apply. The resolution action performs no canonical mutation, scheduling or publication.

## Concurrency and scope

The service takes the existing tenant/venue content lock, then the original proposal row lock, answered question share lock and target share lock. It recomputes the preview after obtaining the row locks. Resolution IDs and request hashes bind exact retries; the unique question binding prevents a second decision. All row reads have explicit tenant/venue filters. Foreign operation collisions fail closed and roll back the attempted replacement.

The immutable SQL record has composite foreign keys, a trigger requiring the exact approved original, answered semantic question and unapproved human replacement, plus append-only enforcement in PostgreSQL and tenant middleware. The preview service independently checks the stored canonical hash and current question evidence; drift requires another explicit conflict resolution. An old successful retry returns its immutable result and never reactivates old content.

The final consumer also pins the replacement proposal target, proposed text, HUMAN creator type and creator ID to the immutable resolution. An edited or re-authored replacement cannot reuse the prior decision. Existing proposals without a resolution retain their previous preview hashes.

## Operator review

`SemanticUpdatePreview` exposes resolution only for an approved, non-temporal targeted correction/supersession with exactly one LOWER_AUTHORITY_CONFLICT blocker and its answered question. The scoped preview router returns the exact server-computed answer hash. The form shows the answer, requires an explicit keep/replace choice and note, and allows replacement wording to be edited independently of the original conflicting desired state.

Before saving, the form freezes the operation UUID and complete request. The parent disables the original preview fields and Close while the request or an unknown outcome is retained. A 15-second bounded request exposes an explicit exact retry on unknown outcomes. Known conflict/not-found/precondition errors require a fresh canonical preview; a new preview generation resets the decision even if the returned snapshot is unchanged. Scope changes abort and fence late results. Retry state is scoped to the mounted review, not advertised as browser-restart persistence.

Success replaces the original proposal controls with the recorded outcome and a scoped review link. The surrounding review row immediately shows CLOSED AFTER RESOLUTION for the exact tenant, venue, proposal and version; markers are pruned to the displayed review set and cannot relabel a newer version. A replacement opens a fresh proposal-review page at its row anchor and still requires separate approval. The form does not create drafts, approve, publish, or mutate canonical guidance.

## Proof and remaining gates

Native `2a3918f077fd` passes on 243 migrations / 261 tables with 29 stable source hashes; PostgreSQL stopped. Its measured source manifest describes the retained historical backend candidate; subsequent adapter and projection changes have separate proof below. See `docs/evidence/semantic-conflict-resolution-native-2026-09-10.json` for exact revision and proof limits. The UI has a separate isolated browser fixture; its API responses are mocked and cannot establish a browser-to-database or live-provider claim. Existing provider/device/customer/release gates and all original requirements remain intact. This slice does not close the full six-class updater, all 32 QA cases, or A/B/C acceptance.

The operator UI proof is retained in `docs/evidence/semantic-conflict-resolution-ui-2026-09-10.json`: candidate `b81f8677`, four viewport cases, 13 stable source hashes, 46 targeted tests, and the owned Next server stopped. The first ambiguous browser selector failure and intermediate passing runs remain retained with their narrower source limits.

## Connected review and saved wording

Candidate `3cfc4220` projects the exact immutable replacement desired state and relation in the scoped proposal list. The preview restores and locks those values; switching scope clears them. The dedicated connected fixture is development-only and requires its explicit integration flag.

`docs/evidence/semantic-conflict-resolution-connected-2026-09-10.json` retains native/browser proof `022796c42f00`: 243 migrations, 261 tables, 46 stable source hashes, one passing connected case, and PostgreSQL/Next stopped. It observes the committed resolution before the lost-response retry, recovers exactly one replacement, separately approves through the real review component, and renders its saved-wording correction preview at 1280/390. Canonical content and module/publication counts remain unchanged. Authentication is synthetic; fixture reload is not a claim about production document routing.

Private legacy adoption now connects a CORRECTION/SUPERSESSION whose target has no native module to the existing adoption service, exact snapshot checks, and bounded provenance reconstructed through the immutable resolution's original support proposal. The package-patch button remains a separate path. Do not copy the unique original support request/version key onto the replacement, bypass proposal binding with the general workbench, or infer publication permission.

## Private legacy adoption adapter

The admin preparation query returns exact proposal/preview/legacy snapshot preconditions from the existing semantic preview and canonical snapshot reader. Creation remains a separate admin mutation through the existing adoption service. The human actor comes from the authenticated session. The new adapter checks that the typed payload carries the same title and content as the approved preview; relationship payloads cannot represent this legacy text and are rejected by this adapter.

Preparation is read-only and is not authorization to publish. Creating the private v1 adoption draft can carry the resolved correction itself. Do not automatically append another semantic universal-content revision: that path requires an exact latest published native target, which a private adoption draft does not provide. The old legacy source remains authoritative until separate publication.

The support UI derives bounded source evidence through the immutable resolution-to-original-proposal relation. Do not copy the original support-version unique key onto its replacement. The low-level admin adapter accepts explicitly authored evidence; the support UI exclusively uses the stricter support-specific mutation described below. Publication creates a separate activation record and leaves the adopted legacy row immutable. The native regression checks exact service replay after publication; that is not browser-restart recovery proof. The existing SQL receipt guard already rejects native-linked targets; the added transactional service check provides an earlier domain conflict.

The support-specific `createSupportLegacyKnowledgeAdoptionDraft` mutation now rejects caller-supplied evidence and reconstructs it from frozen, scoped support-message lineage. Its resolver follows the immutable resolution link to the original proposal, validates the retained request-version audit event, and preserves the bounded ordered message IDs. It returns source references and hashes, never message bodies. The original proposal may be REJECTED after resolution; the current replacement still requires separate APPROVED status and exact semantic checks at creation. The operator panel uses this source-bound mutation.

The adapter rejects disabled desired guidance because native typed draft payloads do not encode the legacy enabled flag. Disabling guidance requires its separate retirement path; adoption must not silently discard that state.

## Operator private draft controls

Candidate `64cfef99` exposes the private draft controls only for supported approved, non-temporal correction/supersession previews with support provenance and an unlinked legacy target. The list exposes only eligibility booleans, not nested source records. Preparation pins the preview hash; content type has no default; approved title/wording remain fixed. The operator supplies required kind-specific metadata and sees the audience explicitly. Disabled guidance uses its separate retirement path.

Before creation the complete request freezes. A bounded request exposes exact retry after an unknown outcome; known rejection requires preparation again. Scope changes fence late results; the parent freezes Close, wording and recomputation while the outcome is retained. Success links to the existing scoped content review, with no publication action in this form. Browser-restart recovery remains outside this component's mounted-session contract.

Connected proof `cd5b3dcac439` on candidate `3c006c5e` passes one native/browser case across prepared and success states at390/768/1280/1440, with54stable source hashes,243migrations/261tables and both servers stopped. It observes the committed private draft before exact retry, verifies retained original support evidence, and leaves publication/activation at zero. See `docs/evidence/support-adoption-connected-browser-2026-09-10.json`. Initial run081d477c6f62 caught receipt contrast and is retained as failed. Native-target/addition support drafting was the next link after that historical candidate; the connected controls are described below.

## Source-bound universal drafts and adoption ownership

The support-specific universal draft adapter derives evidence from the same bounded frozen support lineage as the legacy adoption adapter. It preserves the approved wording and uses the existing exact native base checks. Addition and native supersession have real disposable-router proof in `docs/evidence/support-universal-source-native-2026-09-10.json`; their operator controls are described below.

An adoption already contains its proposal's corrected wording. That proposal must continue to reference its existing adoption revision, including after publication; it must never append a second revision through the support universal route. The adapter checks the scoped receipt early for feedback and repeats the check inside the existing locked draft transaction. The internal optional precondition is not a new client or MCP input. Publication remains a separate explicit action.

The operator UI consumes the server-derived target authoring state query described below. Raw legacy native-link columns stay null after adoption activation and are insufficient for routing. Own adoption receipt always takes precedence and links to the existing revision/status. An unactivated adoption belonging to another proposal blocks new draft creation. An activated adoption belonging to another proposal or a direct native target must satisfy the existing latest published revision checks and fixes the content kind. Untargeted additions and genuinely unadopted legacy targets remain separate choices. Partial links, withdrawn publications, or newer unpublished revisions must fail closed. Reuse the current form and canonical services rather than inventing browser base-version checks.

The later combined connected browser run `b8e9d421a11f` measured candidate `763f2624`, with 54 stable source hashes, eight rendered states across four widths, one passing case, and both servers stopped. Its retained manifest predates the subsequent universal-route transaction guard, which has separate native proof.

## Authoring state query

`getSupportProposalAuthoringState` is a read-only admin query pinned to tenant, venue, proposal and expected proposal version. It returns the existing receipt first, even when the proposal target changed, then distinguishes untargeted, unadopted legacy, another proposal's private adoption, ready native and unavailable/stale native targets. An own adoption remains an own receipt after publication or withdrawal. Current module publication and revision snapshots must not be confused with the original activation event.

This query is display state, not approval, a prepared draft or publication permission. The existing mutations still perform their exact semantic preview, provenance, receipt and locked version checks. The form consumes this state during explicit preparation; the existing `hasLegacyTarget` list boolean is not upgraded into authoring authority.

Native proof `05b47004bfca` (37 measured sources) and `02d63351d104` (28 measured sources) pass on candidate `16268a71`, with PostgreSQL stopped after each. See `docs/evidence/support-authoring-state-native-2026-09-10.json`. The two real-router cases preserve prior adoption/race and addition/supersession assertions while adding authoring-state reads; 21 targeted unit tests and API type/lint checks pass.

## Connected support authoring controls

The existing private-draft form handles support additions and native corrections/supersessions as well as legacy adoption. Explicit preparation reads scoped authoring state. Existing receipts show the original revision and separately qualified current module publication state; the historical activation never substitutes for current status. Another private adoption, missing/partial/conflicting links and stale publications lead to an explanation and scoped content-review link. Native content kind is fixed, while a new addition requires explicit kind selection.

A support-sourced approved non-temporal ADDITION/CORRECTION/SUPERSESSION uses this typed content route even when the semantic preview also has a legacy venue-package patch. ADDITION always has such a patch, so excluding it would hide the intended route. The older package-draft button remains available for other proposals. Mutation approval, exact preview, source evidence, locked receipt and publication checks are unchanged.

Unknown creation outcomes retain the entire exact request including its route. Stale preparation responses cannot cross proposal scopes. Recovered receipts do not invent a version or describe a newer module publication as publication of this draft. Row-level review panels are labeled groups so several open proposals do not create duplicate screen-reader landmarks.

Connected proof `377a67194d49` passes at candidate `97007cf7`:55 stable source hashes,24 rendered states at390/768/1280/1440, one passing case, and both servers stopped. It preserves the legacy flow and proves addition/retry, explicit fixture publication, native supersession and receipt re-entry. See `docs/evidence/support-authoring-connected-browser-2026-09-10.json` for source identities, failed runs, screenshots and exact limits.

## Support completion observes source-bound content

Candidate `694081e6` upgrades newly prepared fulfillment evidence to contract version 3. Existing package APPLY and guest-observability checks remain intact. The shared completion reader additionally follows exact support proposals and one immutable conflict-replacement hop, validates the frozen request audit version, and reads scoped universal/adoption receipts. Proposal and receipt reads are bounded at 100 and fail closed above that bound. The audit lookup preserves both the compound request-version identity and top-level tenant/venue fields required by tenant middleware.

Every content receipt must name the module's latest revision and latest PUBLISH event, be public and currently effective, and have the exact enabled public projection. The actual guest-read adapter must return the same stable projected fields; matching an ID alone is insufficient. Evidence freezes source proposal/request version, receipt, module, revision, publication, projection, observed content hash and guest route/release/state. Verification timestamps do not change the approval digest. A changed receipt or observed content does; the native state hash intentionally also requires approval refresh after unrelated native state changes.

A source proposal with no receipt cannot masquerade as no content work. Only terminal REJECTED proposals or an exact package handoff already verified by the package layer are exempt. Temporal handoffs without their own completion evidence remain blocked. Existing v1 approvals remain compatible only for requests with no packages and no typed receipts; v2 approvals require refresh into current evidence. Human completion re-reads the shared gate; agent completion additionally compares the reviewed immutable evidence under the existing venue content lock. No publication or delivery authority was added.

Native proof `cc03e2e7d387` passes two cases: source-bound addition/supersession and the existing reviewed in-app completion/retry lifecycle. It retains 38 manifest entries for 37 unique source paths, 243 migrations/261 tables and stopped PostgreSQL. Missing-receipt and private-draft reads reject; explicit fixture publication and observable projection permit exact current receipt evidence. A first failed run exposed the missing top-level audit query scope; the fix uses no isolation bypass. See `docs/evidence/support-content-completion-native-2026-09-10.json`.

Remaining completion lanes are explicit: temporal scheduling/activation/expiry outcome evidence; terminal no-op outcome presentation; same-request historical receipt supersession; broader exact-candidate release/physical field QA. An old receipt whose revision is no longer current deliberately blocks completion until a separately designed supersession chain proves the intended outcome. Do not silently discard receipts, infer completion from proposal APPROVED, or publish automatically to satisfy this gate. This slice does not complete all six semantic outcome classes or the original campaign acceptance suite.

Resolved-adoption proof `0db4d14dc666` also passes on candidate `6db637bb`, with 42 measured entries (42 unique sources), one combined case and PostgreSQL stopped. It binds the replacement adoption receipt to the original frozen support request and the actual publication-created projection. The fixture first incorrectly expected the legacy entry ID; the corrected test queries the exact scoped published projection and retains the existing duplicate-route race checks.
