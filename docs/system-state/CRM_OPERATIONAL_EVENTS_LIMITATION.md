# CRM operational-event scope resolution

Date: 2026-08-20

## Decision

`OperationalEvent` remains strictly tenant-owned. Platform prospecting must never be assigned to
a sentinel, inferred, or merely converted tenant. The correction therefore adds a separate
`PlatformOperationalEvent` stream for pre-conversion CRM attention.

`publishCrmOperationalSignal` is scope-discriminated:

- an exact, already-authorized tenant scope delegates to the existing tenant event stream;
- platform CRM scope writes a bounded `PlatformOperationalEvent` visible only to platform admins.

Both paths use deterministic deduplication, severity policy, acknowledgement, resolution, and
linked-object metadata. The admin attention read model merges the streams without weakening the
tenant registry or delivery routing. Platform events are not delivered through tenant alert
destinations.

## Implemented coverage

The policy covers import and duplicate issues, draft/campaign/batch attention, outbox/stuck/
ambiguous operations, provider authentication and Gmail sync failures, replies, follow-ups,
unsubscribes, and agent questions/recommendations. Domain actions publish only selected
high-value signals; adding every policy entry indiscriminately would create noise.

Primary implementation:

- `packages/db/src/helpers/crm-operational-events.ts`
- `packages/db/src/helpers/platform-operational-events.ts`
- `packages/db/prisma/migrations/20260820160000_platform_crm_operational_events/migration.sql`
- `packages/api/src/routers/admin/attention-console.ts`
- `apps/dashboard/components/admin/OperationsAttentionConsole.tsx`

## Remaining boundary

Platform alert delivery beyond the authenticated admin dashboard is intentionally not inferred.
A future email/Slack destination requires a separately approved platform-admin routing model; it
must not reuse tenant routes.
