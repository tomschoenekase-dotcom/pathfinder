# Operational event delivery

Operational events remain the channel-neutral source of truth. The delivery worker periodically materializes a bounded outbox for one explicitly configured route, processes at most 25 due deliveries per job, and records an append-only sanitized attempt audit.

Routing is controlled by `OPERATIONAL_ALERT_MIN_SEVERITY`. Destination addresses are hashed into `destinationKey`; they are not persisted in delivery/audit records. The current external adapter is operator email through the existing Resend provider. Delivery is dark unless `OPERATIONAL_ALERT_DELIVERY_ENABLED=true`, `OUTBOUND_PROVIDER_WORKERS_ENABLED=true`, `REDIS_URL`, `OPERATIONAL_ALERT_EMAIL_TO`, `RESEND_API_KEY`, and an explicit valid `RESEND_FROM_EMAIL` are all configured. Incomplete or ambiguous activation now fails environment validation instead of starting a scheduler that silently does nothing. No packet command enables or sends a live alert.

For development, `OPERATIONAL_ALERT_DEV_SINK_ENABLED=true` selects a non-production structured-log sink and also requires Redis plus provider-worker runtime. It cannot activate in production or at the same time as external delivery. The adapter interface admits future Slack or webhook implementations without changing event/outbox semantics.

Retries use persisted `FAILED` state and `nextAttemptAt` with exponential backoff. Six failed adapter attempts produce `SUPPRESSED` with `retry-exhausted`; operators can inspect the event and its audit rather than entering an unbounded retry loop. The event/destination uniqueness constraint deduplicates routing, while event `deduplicationKey` groups repeated underlying incidents. Every message includes a PathFinder OS record link. Provider response bodies, prompts, credentials, recipient addresses, and raw errors are never stored.

This route currently projects tenant-owned `OperationalEvent` rows. Platform-owned pre-conversion CRM/provider events remain visible in the Founder Control Room but are not claimed as externally delivered by this worker. External activation, recipient selection, severity policy, and any future urgent channel remain owner/configuration decisions.
