# Operational usage evidence

Torchiko retains measured operational quantities separately from monetary cost evidence. This
prevents a queue count or database-declared byte total from becoming a fabricated provider bill,
customer price, margin claim, anomaly threshold, or service-cutoff rule.

## Current observations

- Every worker mode inspects the complete canonical BullMQ queue inventory every 15 minutes.
- A queue observation is accepted only when every declared queue was observed. It records platform
  gauges for total depth, failed jobs, and oldest queued age when queued work exists.
- Once per day, the worker aggregates `IntakeUpload.byteSize`, media project source bytes, and media
  asset bytes by exact tenant and venue. These are explicitly named **declared bytes**: they do not
  prove which objects a provider currently retains.
- Snapshots are content-addressed and operation-idempotent. Worker restarts can replay exact daily
  declared-byte evidence without creating a different fact.
- Founder and platform-worker operating views select only fresh evidence, use the newest declared
  observation per scope, expose missing metrics, and fail visibly when the bounded read truncates.

## Authority boundary

`OperationalUsageEvidence` is append-only. Only a system worker or human platform administrator may
record it through the canonical action. There is no agent write tool. Quantity evidence carries no
USD field and cannot alter invoices, pricing, budgets, entitlements, release policy, anomaly policy,
or service availability.

The existing `OperatingCostEvidence` ledger remains the separate source for independently sourced
non-AI dollar evidence. Connecting measured quantities to provider rates requires explicit rate
provenance and accounting reconciliation; this implementation does not infer either.

## Known limits

- Database-declared bytes are not a provider object inventory, retention disposition, transfer
  total, backup size, or storage invoice.
- Queue gauges are capacity and failure observations, not an SLO or autoscaling decision.
- Email, observability, security, bandwidth, infrastructure, and operator-time quantities remain
  unautomated.
- Hosted continuity is unproven until an authorized staging integration retains observations from
  the deployed worker and exact database/Redis identities.

## Recovery

The migration is additive. If the observer misbehaves, disable its worker composition and retain the
append-only evidence for audit. Repair forward; do not delete or mutate historical observations.
The Founder Control Room already treats missing or stale measurements as unrepresented rather than
zero.
