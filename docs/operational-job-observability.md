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

## Bounded staging recovery correlation

The platform-admin attention console identifies only persisted attempts-exhausted leaf jobs that
meet the static staging redrive prerequisites. An on-demand preview then checks the exact
`JobRecord` against the current BullMQ failed set using a dedicated bounded Redis connection. It
verifies queue/job identity, tenant identity, canonical payload digest, terminal attempt counts,
and failed state before returning bounded evidence. Successful previews are strictly audited.

The ordinary failed-job list still omits BullMQ identity, payload, errors, digests, and confirmation
tokens. The on-demand preview returns the exact BullMQ identity, digest, attempt evidence, and a
current confirmation token to a platform-admin session only; it returns neither payload nor error
detail. The web surface is read-only, staging-only, and has no retry, cancellation, redrive,
incident-control, production, or semantic side-effect authority. Execution remains the separately
opted-in audited staging CLI documented in `terminal-job-redrive.md`.

## Platform-wide live queue evidence

The administrator readiness route and the separately authorized
`POST /api/platform-worker/operations-readiness` endpoint reuse one canonical v2 projection. It
observes all 20 declared BullMQ queues directly from Redis and returns only bounded counts, total
depth, retained failed pressure, pause state, scheduler count, and oldest nonterminal age. A ready
status requires a complete live observation in addition to database/Redis connectivity, migration
parity, and a fresh worker heartbeat; a failed or timed-out queue observation degrades explicitly.

The platform-worker transport requires a disabled-by-default `pf_platform_` credential with
`operations-readiness:read`, accepts no selectors, and strictly audits successful reads. It is not
tenant MCP: the live evidence is platform-wide, supplies no tenant/venue attribution, and includes
no job identity, payload, or failure detail. Exact SLOs, alert thresholds, external provider proof,
control mutation, and automatic restoration policy remain unresolved or gated.

## Verification

- Unit tests cover heartbeat freshness, stale/malformed/absent fail-closed behavior, venue
  predicates, complete queue-inventory coverage, live aggregation, privacy exclusions, summary
  semantics, and authority boundaries.
- A confirmed disposable Redis proof exercises the complete canonical queue inventory, three
  previously unobserved queue classes, a real failed worker job, privacy exclusion, and cleanup.
- A fresh disposable PostgreSQL proof applies every migration and verifies two-venue isolation,
  indexed scope, private payload/error omission, provider-disabled runtime truth, capability denial,
  and exact cleanup.
- Candidate release verification remains the release-confidence authority.

## Rollback

Application rollback can stop reading the new projection while leaving the nullable `venue_id`
column in place. The additive column and index do not alter job execution. Dropping them is not
required for an application rollback; a later reviewed cleanup migration may remove them only after
all readers and writers no longer depend on the scope column.
