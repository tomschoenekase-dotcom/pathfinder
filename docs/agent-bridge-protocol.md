# Torchiko agent bridge protocol

Status: authenticated bridge and standards MCP JSON-RPC transport implemented; provider-neutral
workers register and heartbeat through durable Torchiko state.

New external machine credentials remain disabled by default. A platform administrator can activate
only an exact venue-scoped MCP credential containing `agent-runs:execute`; activation is CAS-bound,
append-only evidenced, strictly audited, and returns no secret. A deployed session still requires
explicit rollout enablement, a legitimate issued credential, and a live worker.

## Why the bridge exists

Torchiko owns durable tasks, tenant and venue boundaries, budgets, approvals, questions, artifacts,
and operator-visible evidence. A user-controlled runner owns provider authentication and model
execution for Hermes, Claude subscription, Codex subscription, or an approved OpenAI-compatible
local endpoint. Torchiko never stores subscription tokens, browser profiles, or plaintext machine
credentials in an agent run or bridge session.

## Session lifecycle

1. An embedding transport verifies an active venue-scoped MCP machine credential containing
   `agent-runs:execute`.
2. The runner registers a UUID session, provider, human label, runner version, and bounded model
   allowlist.
3. Registration creates a two-minute presence lease. Heartbeats renew it. Expired, revoked, or
   credential-disabled sessions cannot claim, heartbeat, complete, or fail work.
4. An administrator can revoke a session through the Agent workspace. Revocation is monotonic and
   audited.

Every call reapplies the exact tenant, venue, credential, provider, and session ownership checks. A
session UUID cannot be rebound to another credential, venue, or provider.

## Task lifecycle

`claimTask` scans a bounded oldest-first set of queued or expired-running tasks matching the session
provider and supported model. When a run declares required worker roles or capabilities in its
scope snapshot, only a registered compatible worker can claim it. A concurrent claim loss advances
to the next eligible task. The database atomically claims the run, increments its bounded attempt
number, creates a short execution lease, and binds that lease to the bridge session and worker. Two
runners cannot validly complete the same lease.

The runner then uses:

- `heartbeatTask` to renew the run lease and observe cancellation;
- `completeTask` to provide a bounded summary, up to 25 text/Markdown/JSON artifacts, the actual
  model name, fixed-point USD cost evidence, and an explicit `UNREPORTED`, `ESTIMATED`, or `EXACT`
  cost status; or
- `failTask` to provide a bounded error code/message and an explicit retryability decision.

Completion and failure require the current lease token and owning live session. Stale workers fail
closed. Retryable failures return to the durable queue only while the attempt budget remains.

The claim response is validated through one strict shared contract used by the database boundary
and runner. It carries the run and operation references, initiating actor, exact agent identity and
authority snapshot, venue, requested operation, model provider/name, scope, attempt, and lease. A
runner rejects venue/provider drift before invoking a model. Nullable free-form prompts fall back to
the durable requested operation instead of becoming poison tasks.

## Operator interaction and specialists

Agents can use `pathfinder.ask_operator` to create durable questions. Blocking questions move a run
to `AWAITING_INPUT`; an operator answer can idempotently redispatch it when the managed runner is
enabled. A PRIMARY identity can use `pathfinder.delegate_specialist` to create an idempotent child
run for an enabled, same-scope specialist. Parent/child lineage, prompts, answers, status messages,
results, artifacts, costs, approvals, and timeline events remain visible in the Agent workspace.

## Transport and deployment boundary

The default-dark dashboard route now composes a bounded authenticated HTTP transport. It verifies
the machine credential before reading the body, streams request bodies under a fixed ceiling, maps
errors without reflecting internals, adds a response request ID, applies a bounded per-process
credential-attempt limiter before Argon2 verification, and remains hidden behind
`AGENT_BRIDGE_HTTP_ENABLED`.

The authenticated `/api/mcp/[tenantId]/[venueId]` route provides JSON-RPC initialize, `tools/list`,
and `tools/call` over the same safe registry. Provider-neutral workers register runtime, protocol,
capabilities, roles, software metadata, and heartbeat; expired leases are reclaimable. The
disposable friend-takeover shakedown proves independent worker registration, task recovery,
account/knowledge retrieval, exact approval consumption, machine attribution, and reconnection
without Obsidian or the primary PC. Production availability still requires explicit rollout,
credential issuance, and a live worker; the UI must not imply otherwise.

`pnpm test:agent-bridge:disposable` proves the provider-dark HTTP/client path, real credential and
session verification, heterogeneous concurrent workers, same-role multiple instances, explicit
role/capability routing, retry and fenced crash takeover, stale-settlement rejection, duplicate
completion rejection, durable artifact readback, exact costs, and a system-initiated workflow that
does not require founder routing. It removes all exact disposable containers afterward. See
`docs/workforce-credibility-shakedown.md` for the exact boundary.
