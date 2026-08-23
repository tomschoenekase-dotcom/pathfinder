# AI provider health control

PathFinder has two distinct platform incident controls:

- the established global AI pause is a fail-closed admission stop for all new provider work;
- the provider-health control supplies explicit exclusions to centrally governed guest-chat text
  and embedding routing without pausing unrelated providers.

Provider exclusions are human platform-admin actions. Each exclusion requires a known provider, an
internal reason, a future expiry, the exact rendered control revision, and a strict audit record.
Expiry restores route eligibility automatically. Removing an override is an explicit audited
recovery action. Concurrent or stale writes fail with a conflict, and audit failure aborts the
control change.

The control is stored separately from the global pause under versioned `PlatformConfig` key
`ai-provider-health-control-v1`. This prevents a global pause/resume action from erasing provider
state and avoids a schema migration for platform-global policy. Malformed or unreadable state fails
closed before guest provider dispatch. The default when no record exists is no provider exclusion.

## Guest behavior

- An active Anthropic exclusion removes Anthropic text candidates from the complete configured
  guest-chat route. If no candidate remains, the turn fails before provider dispatch.
- An active OpenAI exclusion skips query embedding and uses the existing non-semantic venue
  retrieval path; text chat can continue through an eligible text provider. The reserved embedding
  operation is durably settled as `PROVIDER_EXCLUDED` without recording a provider dispatch, so
  turn finalization retains complete and truthful lifecycle evidence.
- One control snapshot is read before either guest provider operation, so a turn cannot begin with
  one provider policy and generate under another.
- No prompt, guest message, token, or provider exception is stored in the control or audit state.

Current OpenAI realtime Voice Mode is intentionally outside this control because it has separate
entitlement, quota, session-admission, and rollout controls. Company Brain evaluations and other
provider call sites that do not yet use central route planning are also outside this specific
override. The global AI pause remains the authoritative broad emergency stop.

## Deliberate boundaries

This control does not infer provider health from one error, choose an outage-rate threshold,
auto-disable a provider, send external notifications, alter prices or customer state, or enable a
new provider. Operators review the concrete evidence, choose a bounded expiry, and retain a direct
recovery path. Automatic provider-health producers require a separately approved threshold and
staging evidence.
