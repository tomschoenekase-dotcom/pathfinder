# AI workload configuration control plane

PathFinder has a persisted, staged AI configuration control plane. It resolves each field in
this order: registry platform default, global workload override, client override, then venue
override. Every effective field reports its winning source independently.

This control plane does not construct provider clients, read or store credentials, call a
provider, apply migrations, or replace `AiBudgetGate`. The Admin OS page writes configuration
metadata only. All new override rows default to `enabled = false`, so creation is staging rather
than activation.

## Registry identity

`AI_CENTRAL_MODEL_REGISTRY` is the only selectable model-key registry. Today its keys are the
same logical keys used as `AiWorkloadId` (for example `guest-chat`, `weekly-report`, and
`guest-query-embedding`). Raw provider model strings are deliberately not accepted. The API
rejects unknown keys, and both API and resolver reject text/embedding cross-kind selection.
The registry remains authoritative for provider model strings, hard limits, and versioned public
price estimates; no pricing is persisted or invented by overrides.

## Persistence and isolation

Global workload rows live in `AiWorkloadConfigurationOverride`, a platform table. The only HTTP
read/write surface is an `adminProcedure`, so authorization completes before the global table is
read. Client and venue rows live in `AiScopedWorkloadConfigurationOverride` and always carry a
required `tenantId`. Their unique identity is `(tenantId, venueScopeKey, workloadId)`, where
`venueScopeKey` is `__client__` for client scope or the exact venue id for venue scope. Venue
requests first prove `(venue.id, venue.tenantId)` ownership, and every scoped query retains the
tenant predicate.

Each configurable field has its own value and `*Set` presence marker. This distinguishes
inheritance from an intentional nullable value. PostgreSQL constraints keep the pairs
consistent, bound timeout/retry/output/fallback values, require decimal budget-unit strings,
and ensure a tombstone is disabled with every value marker cleared.

`revision` is an optimistic compare-and-swap token. Creates require `expectedRevision: null`;
updates and resets require the exact current positive revision. A stale editor produces a
conflict and no false history or audit record.

## Actions, safety, and evidence

Only a human `PLATFORM_ADMIN` actor can invoke the neutral save/reset domain actions. The action
validates the exact client/venue scope inside the transaction. Enabling fallback, switching a
logical model key, increasing attempts or output, increasing/removing an inherited request
budget ceiling, and other spend-expanding changes require explicit
`unsafeChangesEnabled = true`. Cross-kind changes remain impossible even with that acknowledgement.

Reset is non-destructive: the current row becomes a disabled tombstone and increments its
revision. Every create, update, and reset writes both a strict `AuditLog` entry and an immutable
snapshot in the matching history table in the same transaction. Migration-level triggers reject
`UPDATE`, `DELETE`, and `TRUNCATE` against both history tables, covering direct SQL as well as
application code. No schema column or API input accepts credentials.

## Admin workflow

The venue AI configuration page shows:

- effective model, fallback, timeout, attempts, and request ceiling;
- the winning source for model, fallback, and request ceiling;
- existing workload/client/venue override state and venue revision;
- a deliberate venue editor with disabled-by-default activation, required reason, explicit
  unsafe-change acknowledgement, CAS save, and reset-to-inherited action.

The UI states that saving does not trigger provider execution. A configured request ceiling is
metadata used by future dispatch integration; runtime accounting and `AiBudgetGate` remain the
authoritative spend boundary.

## Operational boundary

Migration `20260811234000_add_ai_workload_configuration` is additive and forward-only. It has
been schema-validated and contract-tested locally but must not be applied while the database
incident stop is active. No seed, deploy, provider, Redis, staging, or production operation is
part of this implementation.
