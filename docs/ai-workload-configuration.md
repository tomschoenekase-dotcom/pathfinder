# AI workload configuration foundation

`@pathfinder/ai` exposes a versioned, read-only central projection of the existing text and
embedding registries and a pure scoped resolver. It does not construct provider clients, read
credentials, persist overrides, or call a provider.

Resolution is field-level and deterministic: platform defaults, workload, client, then venue.
Every effective field reports its winning scope. Client and venue identities must match the
requested scope; a venue cannot be resolved without its owning client identity. Disabled
overrides are safe staging records and have no effect.

The existing registry remains authoritative for model IDs, limits, and versioned public-price
estimates. `requestBudgetCeilingE8Usd`, when supplied by an approved configuration store, uses
the existing 1e-8 USD accounting unit and complements rather than replaces `AiBudgetGate`.
No new prices are defined here.

Fallback is empty and disabled by default. Model selection changes, enabling fallback, raising
retry/output/spend ceilings, or removing a finite request ceiling are rejected unless the
override explicitly sets `unsafeChangesEnabled`. That acknowledgement is only a technical
guard; a future persistence/admin layer must still provide authorization, audit, concurrency,
and change-approval controls. Cross-kind text/embedding switching is always rejected.

The current seam intentionally does not mutate existing callers. Consumers can resolve a policy
before dispatch and pass its selected existing registry key and limits into the current provider
functions. Provider availability/failover execution, durable override storage, admin mutation UI,
and new provider adapters remain out of scope.
