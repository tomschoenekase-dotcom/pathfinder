# Intake upload authoritative verification worker

## Decision

Authoritative malware verification is Torchiko-owned background work. A customer uploads and
completes the bounded format precheck; the API then enqueues only tenant, venue, upload, and observed
revision identity. It does not scan bytes synchronously and the customer is not responsible for
retrying the security stage.

## Durable lifecycle

1. The human upload flow owns `RESERVED` and the initial format precheck.
2. A passed precheck stores immutable object-version evidence and moves to `PRECHECK_PASSED`.
3. The API enqueues `intake-upload-verification-process` with an opaque deterministic BullMQ job ID.
4. The worker reloads the upload, claims a ten-minute lease with a deterministic UUID, reads the
   exact stored version, streams it to the configured ClamAV daemon, and transactionally records the
   authoritative receipts and review/rejection transition.
5. A one-minute reconciliation job enqueues a bounded oldest-first set of `PRECHECK_PASSED` uploads
   and `VERIFYING` uploads whose lease expired. Live leases are never stolen.

Queue retries are safe because claim identity derives from the system job identity and settlement is
receipt- and state-fenced. Scanner or storage failure renews the same claim through the bounded retry
series so reconciliation cannot fan out duplicate jobs; exhausted or crashed work becomes eligible
for reconciliation only after lease expiry.

## Authority and audit

The worker uses a verified `SYSTEM` actor with job identity, capability, and idempotency lineage.
System authority is limited to the authoritative stage and cannot claim a `RESERVED` upload. Human
ownership remains required for reservation, byte transport, format precheck, cancellation, and
multipart actions. Audit rows preserve actor type, job identity, capability, before/after status,
tenant, venue, and upload target.

## Admission and operations

`INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED=true` is independent of outbound AI/email worker
authority. Startup fails closed unless Redis, database, object storage, and `INTAKE_CLAMAV_HOST` are
configured. The queue participates in the operational queue snapshot. Platform intake review shows
queued, running, automatic-recovery, and initial-client-resume states without exposing claim IDs,
storage identity, scanner output, hashes, or raw errors.

No part of this worker authorizes production deployment, customer contact, live billing, destructive
data reset, or publication of uploaded content.
