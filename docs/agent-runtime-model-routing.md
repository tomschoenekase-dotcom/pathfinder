# Governed agent runtime model routing

Direct Torchiko agents select the centrally managed `agent-run` workload. An
identity no longer freezes an Anthropic model name. The effective platform,
client, and venue configuration determines the primary model, fallbacks,
timeout, attempts, output limit, and optional cumulative request-cost ceiling.

## Identity routes

- `anthropic` plus `central:agent-run` means direct execution through the
  governed workload route.
- `hermes-bridge`, `claude-bridge`, `codex-bridge`, and
  `openai-compatible-bridge` retain a nonempty explicit bridge model target.
- Provider and target must both be absent or both be present. The database
  migration converts the previous direct `claude-sonnet-4-6` target and adds a
  check constraint that rejects mixed or unsupported state.

The identity editor labels direct execution as “Torchiko managed AI,” disables
the misleading model input, and links to the venue workload configuration.
Saving or enabling an identity does not contact a provider or start a run.

## Runtime controls

Before direct dispatch, the worker:

1. resolves the effective `agent-run` configuration for the exact tenant and
   venue;
2. reads active provider-health exclusions;
3. builds the provider-neutral `REASONING` route;
4. applies the configured timeout, attempts, output bound, and cumulative
   request ceiling;
5. performs the existing venue admission and durable tenant-budget reservation;
6. retains the chosen capability, workload, configuration version, model key,
   and fallback status beside the result.

The request ceiling covers the entire logical request, not each attempt in
isolation. Exact settlements consume observed cost, undispatched reservations
are released, and ambiguous dispatches conservatively consume their full
reservation. A rejected ceiling prevents provider I/O and does not become
retryable agent work.

## Boundaries

This is locally implemented and provider-dark proven. It does not configure
credentials, authorize spend, run a live model, connect a subscription bridge,
deploy staging or production, or weaken existing human approval and agent-tool
policy. Provider-backed fallback and bridge compatibility still require an
authorized staged smoke test with bounded spend.
