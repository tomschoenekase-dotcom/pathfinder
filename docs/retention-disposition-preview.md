# Retention disposition preview

Torchiko now has a full-client, read-only retention disposition preview. It exists to make the
owner/legal policy decision concrete without inventing a duration, legal basis, disposition,
approval, or execution authority.

## What it proves

`previewRetentionDispositionAction` verifies the exact tenant root and counts every model in the
canonical tenanted and shared-scope registries with an explicit `tenantId` predicate. Counts run in
bounded batches. The current catalog projects:

- 156 exactly countable tenant-root or tenant-linked model classes;
- 52 platform-owned model classes that cannot be attributed to a client by `tenantId` alone;
- the existing 19 owner-decision mappings from `RETENTION_DATA_INVENTORY`;
- every tenant-linked model still missing an owner/legal classification;
- external-reference records whose provider or object-store artifacts are not counted.

These numbers are generated from the canonical model registries and are protected by repository
inventory tests; they are not a promise that every stored artifact is covered.

## Surfaces

- Platform administrators: `admin.previewRetentionDisposition({ tenantId })`.
- Authorized operating agents: MCP resource `pathfinder.retention-preview`, requiring the dedicated
  client-scoped `retention:read` capability.
- Fresh disposable proof:
  `pnpm test:retention-disposition-preview:disposable`.

The administrator procedure and MCP resource accept only a client identifier. They cannot accept a
policy fixture, duration, action, approval, venue subset, provider target, storage target, or
destructive instruction.

## Fail-closed boundaries

The preview always reports `readyForExecution: false`. It also reports explicit blockers for:

- missing owner/legal policy decisions;
- tenant-linked models without a retention classification;
- platform-owned data without direct tenant attribution;
- object-store and provider artifacts outside the database count;
- any unavailable database count;
- the absence of a reviewed executor.

No route, queue, worker, database procedure, approval grant, deletion, anonymization, revocation,
provider call, object-store call, customer contact, billing action, or backup action is introduced.
The preview writes no audit row because it is a count-only read; any future persisted approval or
execution workflow requires separate immutable evidence.

## Disposable evidence

The fresh proof migrates a new isolated PostgreSQL database, creates two synthetic tenants with one
venue and visitor session each, and verifies that each preview counts only the requested client. It
also verifies unchanged tenant, venue, session, and audit counts before and after the preview.
PostgreSQL, Redis, MinIO, and ClamAV remain provider-dark and are removed with verified absence.

## Remaining owner/legal work

The preview makes policy gaps inspectable; it does not resolve them. Owner/legal review must still
classify every relevant model and external artifact, define retention and legal-hold treatment,
approve backup/restore behavior, define provider-side obligations, and authorize a separately
reviewed preview/approval/execution/receipt lifecycle before any destructive implementation can be
enabled.
