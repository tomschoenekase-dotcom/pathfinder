# Operational-update domain actions

Packet 2's client-approved simple-update write boundary is
`packages/db/src/helpers/operational-update-actions.ts`. It is the canonical seam for the current
dashboard/API and a possible future approved adapter. The module does not expose an MCP tool and
does not authorize autonomous writes.

## Contract

- `createOperationalUpdateAction` creates a draft or creates and schedules it when the existing UI
  explicitly requests publication.
- `updateOperationalUpdateAction` edits with `expectedUpdatedAt` compare-and-set protection and can
  schedule an existing draft when explicitly requested.
- `scheduleOperationalUpdateAction` moves a current, unexpired draft to the published lifecycle.
- `expireOperationalUpdateAction` makes an active published update inactive. The existing tRPC
  procedure retains its compatibility name `deactivate`.
- Every action requires an exact tenant ID and a typed `HUMAN` actor whose role is `MANAGER` or
  `OWNER`. Route adapters derive both from the authenticated session; callers cannot supply them.
- Results include the persisted update plus deterministic preview data (`DRAFT`, `SCHEDULED`,
  `LIVE`, `EXPIRED`, or `INACTIVE`) and whether it is guest-visible at the preview instant. The
  compatibility tRPC procedures continue returning only the update, so authorized UI behavior and
  response shape do not change.

## Safety and audit boundary

Each action owns one database transaction. Inside it, the action sets the human content-version
actor context, uses tenant-scoped venue/place/update reads, takes the existing entity/capacity lock,
performs state and timestamp validation, applies tenant-scoped CAS, and appends the strict platform
audit record. Existing database triggers append `ContentVersion` history in that same transaction.
An audit failure rolls the write back; a stale CAS never emits a false audit.

Scheduling rejects expired windows and the existing overlapping guest-update capacity remains 20.
Edits to an active published update cannot move its expiry into the past. Place scope is checked by
tenant and venue together. No schema, listener, credential, job, autonomous expiry, or external
operation is part of this foundation. The external database incident stop remains active, so this
slice was verified only through static checks and mocked unit/router tests.
