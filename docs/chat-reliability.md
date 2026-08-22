# Guest chat reliability telemetry

PathFinder deliberately returns a canned guest-safe response when model generation fails. The server records that degraded result without storing prompt or response content in the reliability signal.

## Server events

Every successfully persisted assistant response emits `message.received` with:

- `fallback`: whether the canned model-failure response was returned;
- `retrievalMode`: `semantic` or `geo-or-importance`;
- `embeddingMs`, `retrievalMs`, `promptAssemblyMs`, `modelMs`, `persistenceMs`, and `totalMs`;
- a sanitized gateway `failureCode` only when fallback occurred.

A fallback also emits `message.fallback` with `failureStage: generation`, the sanitized failure code, and the same timings. It is intended for live logs/alerts. Both events are server-only and are rejected by the public analytics mutation.

When every configured generation candidate is exhausted and the safe response is durably
committed, guest chat also publishes `guest-chat.route-degraded` to the tenant's operational
event stream. The event is grouped by venue and routing-configuration version, links to the venue
chat review surface, and contains no prompt, response, guest token, or provider exception text.
A configured fallback candidate that succeeds does not create an incident. Unexpected
post-dispatch failures retain separate per-turn evidence rather than being mislabeled as route
exhaustion. Operational-event publication is best-effort and cannot prevent the safe response.

Before returning that canned response, guest chat executes the ordered fallback candidates from
its centrally resolved workload configuration. Only gateway/provider failures may advance the
route; admission, budget, policy, accounting, abort, and durable-dispatch failures stop without an
extra model call. Each attempted candidate writes route-aware usage evidence, and all candidates
remain inside one durable response-generation operation.

`totalMs` ends after the response and engagement state are durably persisted; it intentionally excludes best-effort analytics emission. These are completed-request timings, not time-to-first-token measurements because guest chat is not yet streamed.

## Daily rollups

The nightly `daily-rollup` worker derives tenant- and venue-scoped metrics from server-emitted `message.received` events:

- `chat_responses`
- `chat_fallbacks`
- `chat_fallback_rate_bps` (basis points; 100 = 1%)
- `chat_embedding_p50_ms` and `chat_embedding_p95_ms`
- `chat_retrieval_p50_ms` and `chat_retrieval_p95_ms`
- `chat_prompt_assembly_p50_ms` and `chat_prompt_assembly_p95_ms`
- `chat_model_p50_ms` and `chat_model_p95_ms`
- `chat_persistence_p50_ms` and `chat_persistence_p95_ms`
- `chat_total_p50_ms` and `chat_total_p95_ms`

Malformed or missing timing fields are ignored. An empty day produces explicit zero response, fallback, and fallback-rate values but no percentile rows, preserving the difference between an unsampled stage and a legitimate zero-millisecond measurement. The existing tenant-scoped `analytics.getDailyStats` procedure exposes these rows.

The dashboard presents the latest day with completed responses in the requested 30-day window for each active venue. Older p95-only rows remain readable and show p50 as unavailable rather than fabricating it.

## Limits and rollout

- Analytics writes remain best-effort, so a database outage can undercount reliability events.
- No outage-rate threshold or external alert destination is chosen here. A concrete degraded
  guest turn appears in the Founder Control Room without inventing phone/push escalation policy.
  Live Sentry/Railway alert configuration still requires staging access and an approved operating
  threshold.
- These metrics contain IDs, counts, sanitized error codes, and durations only. They do not add guest questions, model responses, prompts, or provider error messages.
- The current text adapter registry is Anthropic-only. Central model fallback is active; cross-provider text failover still requires another governed text adapter and staging proof.
- `routeAiCapability` accepts provider-health exclusions, but no canonical health-state producer or
  automatic provider-disable threshold is established yet. The incident evidence added here does
  not mark providers unhealthy or mutate routing.
