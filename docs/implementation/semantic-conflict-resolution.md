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

Native `2a3918f077fd` passes on 243 migrations / 261 tables with 29 stable source hashes; PostgreSQL stopped. Its measured backend sources still match the operator UI candidate. See `docs/evidence/semantic-conflict-resolution-native-2026-09-10.json` for exact revision and proof limits. The UI has a separate isolated browser fixture; its API responses are mocked and cannot establish a browser-to-database or live-provider claim. Existing provider/device/customer/release gates and all original requirements remain intact. This slice does not close the full six-class updater, all 32 QA cases, or A/B/C acceptance.

The operator UI proof is retained in `docs/evidence/semantic-conflict-resolution-ui-2026-09-10.json`: candidate `b81f8677`, four viewport cases, 13 stable source hashes, 46 targeted tests, and the owned Next server stopped. The first ambiguous browser selector failure and intermediate passing runs remain retained with their narrower source limits.
