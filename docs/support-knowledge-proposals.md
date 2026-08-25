# Support-linked knowledge proposals

Torchiko can turn one reviewed client content-correction request into one separately reviewable
knowledge proposal without collapsing support, editorial review, and publication authority.

## Exact source boundary

The bridge accepts only a `CONTENT_CORRECTION` request in `IN_REVIEW`, `PATCH_DRAFTED`,
`VALIDATING`, `AWAITING_APPROVAL`, or `APPLYING`. It freezes:

- tenant and venue;
- support request ID and exact current version;
- the append-only audit event for that exact version;
- one to twenty immutable support messages belonging to that request at or before the frozen version;
- correction kind, proposed change, reason, confidence, optional inference, and optional exact target
  knowledge entry;
- human or verified-agent lineage.

One exact request version can produce only one proposal. Revisions require a new support-request
version rather than silently replacing historical evidence. A database trigger prevents the source,
evidence, proposed content, and creator from being rewritten after creation while still allowing the
ordinary human review status fields to change.

## Authority separation

The bridge creates `PENDING_REVIEW` evidence only. It does not:

- change the support request or its client-activity version;
- add a support message or contact the customer;
- approve the proposal;
- create, update, retire, publish, or re-embed canonical venue knowledge;
- approve or apply a venue package;
- grant pricing, billing, deployment, or data-destruction authority.

A platform administrator can prepare the handoff in Support Operations. An exact-scope worker with
the existing `knowledge:draft` capability can call
`torchiko.knowledge.prepare_from_support`; the worker and active run must match its credential. Both
paths converge on the same transaction and immutable provenance contract.

The Knowledge Proposal review queue links back to the source request/version. Human approval remains
non-publishing under the existing proposal lifecycle.

## Verification

- Migration contract: exact source pair, composite audit-event foreign key, one-per-version index,
  and source immutability trigger.
- Disposable PostgreSQL proof: exact replay, duplicate rejection, request preservation, zero
  canonical knowledge, strict agent audit, tamper rejection, and separate review compatibility.
- API/MCP/UI tests: human and agent preparation, exact message selection, source navigation, and
  truthful no-publication/no-contact copy.

No hosted deployment or provider is required for this provider-dark lifecycle.
