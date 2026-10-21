# Local Luna planner service profiles

This default-off development/test experiment changes only the structured-query planner's
service tier. It neither selects a model nor changes route/provider/tenant configuration.
The existing local structured-query admission must allow PUBLIC LEGACY/DARK reads.
Set TORCHIKO_LOCAL_STRUCTURED_QUERY=1 and TORCHIKO_LOCAL_LUNA_PLANNER_PROFILE=standard
for explicit service_tier=default, or fast for explicit service_tier=fast. Direct answers
still require the separate existing TORCHIKO_LOCAL_DIRECT_QUERY=1 setting. Production,
NATIVE and nonPUBLIC scopes never receive an experimental profile. Unset profile keeps
existing request bytes, rates and retry behavior. No project-wide service-tier setting changes.

A selected profile requires one compatible registered OpenAI Luna primary candidate,
one attempt, nonstream, at most1024 output tokens, and no cache breakpoint. The same
prepared-bound planner parser validates output inside the accounted gateway. Invalid
JSON/schema fails the planner operation; valid UNSUPPORTED remains an ordinary decision
and can use the unchanged answer-model path. That answer call receives no tier override.

Both explicit profiles reserve2x the existing conservative registered text ceiling before
dispatch and share the existing request budget with any ordinary answer call. The pinned
short-context2026-09-22 Luna rates are checked against the registry, never rewritten.
Observed default settles1x; observed fast/priority settles2x. A Fast→default downgrade is
successful but labelled STANDARD_DOWNGRADE. Unexpected Fast on the Standard control is
settled honestly then fails that control operation. Response ID is required for success.

Profile-only raw usage validation requires exact returned Luna model, safe integer raw
input/output/read/write/total/reasoning counts, consistent sums, registered input/output
bounds, and zero cache writes without a breakpoint. Missing or unsupported partitions,
12h writes and unknown tier fail closed with the full ambiguous hold, not a conservative
estimate labelled actual. Unknown cost records use a zero diagnostic estimate plus
UNKNOWN status/tier-unknown or usage-unknown pricing version; the durable full hold is
still consumed. Zero is not a free-call or observed-cost assertion.

All selected-profile postdispatch failures use a nonfallback execution error. Known valid
usage is settled once before incomplete/output-validation failure; unobserved/unpriceable
usage retains the full hold. Accounting outages cannot cause another SDK dispatch.
The selected profile, model spec and prompt inputs are captured before admission/reserve;
local profile changes are rechecked with existing source/native/config fences.

Receipts retain requested profile/tier, observed tier/outcome, provider response ID, cost
observation and multiplier, exact JSON.stringify SDK-parameter UTF8 bytes/hash, source/query
and route bindings. SDK parameter bytes are not a claim to observed HTTP serialization.
Provider response IDs persist in the existing usage providerRequestId column; tier-specific
pricingVersion persists the applied schedule. There is no schema migration or fake answer
usage. The unchanged local deterministic renderer still invokes no answer model.

No cache padding,12h caching, provider latency improvement or production rollout is claimed.
Offline SDK/usage fixtures and mocked router tests prove mechanics only. Paid transport,
real provider usage and final clean-source capture need separate root approval/evidence.
