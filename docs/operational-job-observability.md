# Operational job observability

## Present implementation

`pathfinder.read` resource `jobs` is the bounded operational adapter for one credential-authorized
tenant and venue. Schema v2 returns recent safe job rows plus an all-history persisted summary by
status and terminal failure disposition. `JobRecord.venueId` is a nullable, indexed scope column;
the migration backfills it from the former `payload.venueId` convention. New records derive the
column when the canonical `writeJobRecord` helper receives a venue-scoped payload.

The resource also returns `projectWorkerHeartbeat`, the same fail-closed worker-runtime projection
used by administrator readiness. Heartbeats are fresh for 90 seconds and otherwise stale. Missing
or malformed schemaless `PlatformConfig` state is never interpreted as healthy. A provider-disabled
heartbeat is valid runtime evidence but not provider-execution evidence.

## Boundaries

The read excludes `JobRecord.payload`, `error`, and BullMQ identity. It does not connect to Redis,
inspect live queues, prove queue depth, prove provider execution, or infer that no persisted rows
means a healthy service. The existing 15-minute long-running boundary is diagnostic only; it is not
an SLO, incident declaration, retry decision, or customer commitment.

The adapter grants no retry, cancellation, redrive, provider, incident-control, deployment, or
production authority.

## Target architecture and remaining gap

The administrator readiness route retains bounded live Redis connectivity and queue snapshot
probes. A future separately authorized agent surface may expose a safe projection of that canonical
live evidence, migration parity, and external service probes. Exact SLOs, alert thresholds, and
automatic restoration policy remain unresolved and must not be inferred from diagnostic windows.

## Verification

- Unit tests cover heartbeat freshness, stale/malformed/absent fail-closed behavior, venue
  predicates, privacy exclusions, summary semantics, and authority boundaries.
- A fresh disposable PostgreSQL proof applies every migration and verifies two-venue isolation,
  indexed scope, private payload/error omission, provider-disabled runtime truth, capability denial,
  and exact cleanup.
- Candidate release verification remains the release-confidence authority.

## Rollback

Application rollback can stop reading the new projection while leaving the nullable `venue_id`
column in place. The additive column and index do not alter job execution. Dropping them is not
required for an application rollback; a later reviewed cleanup migration may remove them only after
all readers and writers no longer depend on the scope column.
