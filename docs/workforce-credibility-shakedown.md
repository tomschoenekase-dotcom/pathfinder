# Workforce credibility shakedown

Status: provider-dark disposable proof implemented. Hosted bridge connectivity and provider-backed
work remain separately gated.

`pnpm test:agent-bridge:disposable` starts isolated PostgreSQL, Redis, MinIO, and ClamAV resources,
applies the complete reviewed migration lineage, exercises the authenticated HTTP bridge through
real database state, and verifies that every exact disposable resource is absent afterward.

The workforce scenario registers seven heterogeneous workers: two independent Researchers, a
Venue Builder, Venue Updater, Support worker, Analyst, and CRM reply processor. Seven
system-initiated runs are claimed concurrently. Each run declares required worker roles,
capabilities, realistic work input, and explicit no-contact/no-publication/no-billing limits in its
immutable scope snapshot. The bridge skips incompatible work, and a bounded candidate scan
continues after a concurrent claimant wins an earlier task.

All seven roles now exercise canonical company data or governed review evidence:

- Both Researchers create machine-attributed, venue-scoped `MARKET_RESEARCH` candidates with
  `INFERENCE` authority. Neither candidate is promoted or represented as current truth; reuse of
  the first operation identity with conflicting content is rejected.
- Venue Builder prepares a typed accessible-entrance draft proposal and stops in
  `AWAITING_APPROVAL`. No canonical location is created or activated.

- Venue Updater creates a machine-attributed changed-hours operational-update draft. It remains
  inactive and unpublished.
- Support evaluates a realistic stale-admission issue, creates the canonical review request, and
  stops in `AWAITING_APPROVAL`; the support request remains unchanged and no customer is contacted.
- Analyst uses two retained mixed/negative outcome observations to prepare an evidence-backed
  retrieval-improvement proposal and stops in `AWAITING_APPROVAL`. Review cannot execute the
  proposed workflow change.
- CRM processes a matched inbound prospect reply, advances the real opportunity from `CONTACTED`
  to `REPLIED`, retains the activity/audit lineage, and creates no outbound message or send outbox.

The same disposable lifecycle exercises three additional negative paths. A conflicting knowledge
write with the same operation identity is rejected. Two simultaneous 75-unit reservations against
a 100-unit tenant budget admit exactly one attempt and deny the other; the admitted reservation is
released only because dispatch never started, returning all capacity without spend. A separate
one-attempt research run records terminal `PROVIDER_UNAVAILABLE` failure with zero artifacts and
zero cost instead of falsely completing.

The same scenario expires one researcher's execution lease and proves takeover by the second
researcher. The database permits only that fenced `RUNNING`-to-`RUNNING` ownership transfer: the old
lease must already be expired, the attempt must increment exactly once, and the new lease token and
bridge owner must both change. The stale worker cannot settle the run, and a repeated completion by
the current worker is rejected. Exactly one completion event remains.

The four completed runs retain initiating actor, agent identity, tenant and venue scope, requested
operation, provider and model, exact fixed-point cost status, durable artifacts, timestamps, and
terminal state. Venue Builder, Support, and Analyst deliberately retain three pending approvals
instead of claiming false completion. The separate provider-failure run is honestly `FAILED`. No
run creates a founder question. Customer communication, publication, billing, deployment,
production, destructive changes, and provider spend remain governed by their existing independent
permission and approval boundaries.

This proof does not claim a live subscription bridge, live provider quality, distributed load
capacity, or production readiness. Those require an explicitly admitted hosted worker and separate
provider-backed staging evidence.
