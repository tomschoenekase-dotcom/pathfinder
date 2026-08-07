# Guest chat reliability telemetry

PathFinder deliberately returns a canned guest-safe response when model generation fails. The server records that degraded result without storing prompt or response content in the reliability signal.

## Server events

Every successfully persisted assistant response emits `message.received` with:

- `fallback`: whether the canned model-failure response was returned;
- `retrievalMode`: `semantic` or `geo-or-importance`;
- `embeddingMs`, `retrievalMs`, `promptAssemblyMs`, `modelMs`, `persistenceMs`, and `totalMs`;
- a sanitized gateway `failureCode` only when fallback occurred.

A fallback also emits `message.fallback` with `failureStage: generation`, the sanitized failure code, and the same timings. It is intended for live logs/alerts. Both events are server-only and are rejected by the public analytics mutation.

`totalMs` ends after the response and engagement state are durably persisted; it intentionally excludes best-effort analytics emission. These are completed-request timings, not time-to-first-token measurements because guest chat is not yet streamed.

## Daily rollups

The nightly `daily-rollup` worker derives tenant- and venue-scoped metrics from server-emitted `message.received` events:

- `chat_responses`
- `chat_fallbacks`
- `chat_fallback_rate_bps` (basis points; 100 = 1%)
- `chat_embedding_p95_ms`
- `chat_retrieval_p95_ms`
- `chat_prompt_assembly_p95_ms`
- `chat_model_p95_ms`
- `chat_persistence_p95_ms`
- `chat_total_p95_ms`

Malformed or missing timing fields are ignored; an empty day produces explicit zero values. The existing tenant-scoped `analytics.getDailyStats` procedure exposes these rows.

## Limits and rollout

- Analytics writes remain best-effort, so a database outage can undercount reliability events.
- No alert threshold or destination is chosen here. Live Sentry/Railway alert configuration requires staging access and an approved operating threshold.
- These metrics contain IDs, counts, sanitized error codes, and durations only. They do not add guest questions, model responses, prompts, or provider error messages.
