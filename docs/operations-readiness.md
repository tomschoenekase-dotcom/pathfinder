# Operations readiness

`admin.operationsReadiness` is a platform-admin-only tRPC query. `/api/health` remains the cheap public liveness endpoint and performs only bounded database and Redis checks.

The readiness projection combines 1.5-second DB/Redis probes with persisted evidence for the expected/latest migration, worker heartbeat and mode, recent job state and oldest recorded job, scheduler observability, worker-observed object-storage and malware-scanner connectivity, recent upload verification, AI outcomes, embedding outcomes, email jobs, and stuck critical jobs. It reports `degraded` when DB, Redis, migration parity, a 90-second worker heartbeat, intake verification, fresh storage/scanner evidence, complete live queue coverage, queue flow, or critical-job flow is missing.

The expected migration is the exact reviewed tip, not merely a count. `scripts/operations-readiness-migration.test.mjs` derives the latest checked-in migration and fails whenever the runtime constant drifts. `pnpm test:operations-readiness:disposable` applies the full migration lineage to fresh isolated PostgreSQL, records a provider-dark worker heartbeat, and proves exact parity while external provider evidence remains explicitly unobserved. This prevents a correct deployment from appearing degraded because an older application constant survived a migration addition.

The readiness request does not call AI, email, object-storage, or malware providers. Instead, the worker heartbeat performs bounded, read-only `HeadBucket` and ClamAV `PING` probes and persists only `up`, `down`, or `unconfigured` plus observation time. Success expires after 90 seconds, so an old upload receipt or probe cannot masquerade as current connectivity. `not-observed` is intentional when no recent durable evidence exists. Queue depth, failed count, and oldest queued age come from a bounded Redis/BullMQ inspection; a timeout falls back to explicitly labeled persisted `JobRecord` evidence. Scheduler-host freshness is carried in the worker heartbeat; individual schedule execution freshness still depends on the corresponding job evidence.

The provider-disabled venue-media derivative runtime emits the same bounded operational heartbeat and dependency observation. It reports provider execution and recurring schedulers as disabled, probes only configured storage/scanner dependencies, and never opens an outbound provider queue. This keeps a deliberately dark staging worker attributable without misrepresenting it as fully provider-ready.

`pnpm test:operations-readiness:disposable` creates an isolated versioned bucket, probes the real MinIO and ClamAV services without external providers, reads the production readiness projection, and verifies all four dependency containers are absent after cleanup.

Operational access requires normal platform-admin authentication. Never expose this projection through a public route or client bundle.
