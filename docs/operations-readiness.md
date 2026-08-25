# Operations readiness

`admin.operationsReadiness` is a platform-admin-only tRPC query. `/api/health` remains the cheap public liveness endpoint and performs only bounded database and Redis checks.

The readiness projection combines 1.5-second DB/Redis probes with persisted evidence for the expected/latest migration, worker heartbeat and mode, recent job state and oldest recorded job, scheduler observability, recent object/malware verification, AI outcomes, embedding outcomes, email jobs, and stuck critical jobs. It reports `degraded` when DB, Redis, migration parity, or a 90-second worker heartbeat is missing.

The expected migration is the exact reviewed tip, not merely a count. `scripts/operations-readiness-migration.test.mjs` derives the latest checked-in migration and fails whenever the runtime constant drifts. `pnpm test:operations-readiness:disposable` applies the full migration lineage to fresh isolated PostgreSQL, records a provider-dark worker heartbeat, and proves exact parity while external provider evidence remains explicitly unobserved. This prevents a correct deployment from appearing degraded because an older application constant survived a migration addition.

The projection does not call AI, email, object-storage, or malware providers. `not-observed` is intentional when no recent durable evidence exists. Queue depth, failed count, and oldest queued age come from a bounded Redis/BullMQ inspection; a timeout falls back to explicitly labeled persisted `JobRecord` evidence. Scheduler-host freshness is carried in the worker heartbeat; individual schedule execution freshness still depends on the corresponding job evidence.

Operational access requires normal platform-admin authentication. Never expose this projection through a public route or client bundle.
