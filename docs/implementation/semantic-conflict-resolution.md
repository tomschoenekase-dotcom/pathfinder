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

## Remaining integration

The API and durable backend are the current slice. The existing SemanticUpdatePreview UI still needs a scoped resolution form showing the actual answer, keep/replace choice, editable replacement and note, and navigation to the pending replacement review. Native evidence must pass before claiming this backend verified. Existing provider/device/customer/release gates and all original requirements remain intact.
