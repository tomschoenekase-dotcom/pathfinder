# First-week account learning

## Purpose

Torchiko now derives privacy-bounded day 1, day 3, and day 7 account reviews from the first
canonical `RELEASED` onboarding milestone for each venue. The same aggregate evidence is readable
in the internal client analytics workspace, while only a useful draft-ready item appears in the
Founder Control Room.

This closes the first-customer learning loop without creating customer-contact authority.

## Durable evidence

`FirstWeekAccountReview` is append-only and tied by a tenant-and-venue composite foreign key to the
exact release milestone. Fixed review windows end at release plus one, three, or seven days. Each
snapshot retains:

- public session and guest-question counts;
- low-confidence and knowledge-gap insight counts;
- negative feedback and newly created support-request counts;
- AI request/failure counts and estimated provider-pricing cost;
- an immutable content hash;
- either `NO_ACTION` or `DRAFT_READY`.

Raw conversations, feedback reasons, insight summaries, customer addresses, and provider payloads
are not copied into review evidence.

The nightly analytics-enrichment worker materializes every due milestone. A venue-scoped advisory
lock and unique release/milestone identity make retries idempotent. Replays verify the stored hash
and do not increment Founder Control Room event occurrence counts.

## Draft and authority boundary

Day 1 or day 3 creates a draft only when an aggregate quality/support/failure signal exists. Day 7
may also create a relationship check-in draft when real public usage exists without a problem
signal. Empty or uneventful milestones remain quiet and create no operational alert.

A stored draft has a subject, body, and internal reason only. It has:

- no recipient;
- no email or messaging provider;
- no outbox/delivery record;
- no send action;
- no customer promise, price, credit, SLA, or contract language.

The admin UI labels it “Draft only — nothing has been sent.” A human may edit, discard, or use it
through a separately authorized communication workflow.

## Verification

`pnpm test:first-week-learning:disposable` creates fresh digest-pinned PostgreSQL/pgvector, Redis,
MinIO, and ClamAV containers, applies the complete 184-migration lineage, and proves:

- exact day 1/3/7 release windows;
- aggregate-only snapshots;
- useful-draft and quiet-no-action behavior;
- replay stability and deduplicated operational events;
- tenant/venue isolation;
- append-only database enforcement and strict audit evidence;
- zero operational-event delivery;
- exact disposable cleanup.

This local provider-dark proof does not establish hosted scheduler continuity, live provider
quality, customer usage, or permission to contact a customer.
