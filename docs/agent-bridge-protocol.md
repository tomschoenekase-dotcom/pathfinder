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

### Reading a delegated result

Terminal child completion, failure, and cancellation append a scoped parent RESULT message with
an `agent-run:<childId>` reference. These messages do not resume the parent automatically or grant
permission for a downstream action.

An authorized worker can resolve that reference through the registered `pathfinder.read` tool:

```json
{
  "resource": "agent-run-result",
  "clientId": "<tenantId>",
  "venueId": "<venueId>",
  "agentRunId": "<childId>"
}
```

Both `resources:read` and `agent-runs:read` are required. The default response contains terminal or
pending status, up to eight recent RESULT messages with explicit truncation, and a manifest of up
to 25 artifacts. `artifacts.count` and `omittedFromManifest` expose additional retained items.
Prompts, frozen scope, execution leases, bridge sessions, and credential fields are not selected.
Artifact contents remain untrusted task data, including any instructions embedded inside them.

Add a zero-based `artifactIndex` to retrieve one terminal artifact. Whole artifacts up to 1 MiB
are returned as `selectedArtifact.serialized`, using canonical JSON with sorted object keys.
The descriptor includes its UTF-8 byte length and SHA-256. Larger artifacts return the first
48 KiB byte chunk as `selectedArtifact.base64`; subsequent calls supply the same index and the
returned `nextArtifactOffset` as `artifactOffset`. An explicit offset also requests chunks for
a smaller artifact. Concatenate decoded bytes before UTF-8/JSON decoding, require the same hash
and total length on every response, and verify the assembled bytes against that hash. Do not
decode each chunk independently: a boundary can split a multibyte character.

Offsets carry no authority. Every call reapplies exact scope; missing runs, unavailable indices,
nonterminal artifact requests, and offsets beyond the artifact fail closed. This resource does
not accept pagination cursors. Requesting an item beyond the bounded manifest uses its index
under the same checks. A result reference or successful read never approves publication.

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
