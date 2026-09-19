# Torchiko desktop agent bridge runner

Status: implemented and tested; default-dark; not launched or authenticated by this change.

The runner connects one local Codex, Claude, Hermes, or OpenAI-compatible process to one exact
Torchiko venue. It registers a durable provider-neutral worker identity, polls the authenticated
bridge endpoint,
executes one compatible leased task at a time, sends session, worker, and task heartbeats, observes
durable cancellation, and posts a bounded Markdown artifact or a non-secret failure code. The
worker key remains stable across process restarts; expired heartbeats make vanished processes
visible without losing queued work.

## Safety profile

- The machine secret is accepted only from `TORCHIKO_AGENT_BRIDGE_SECRET`, sent only as the Bearer
  header, and never logged or included in a request body.
- Endpoint URLs must be HTTPS, except exact `localhost`/`127.0.0.1` HTTP development targets. URL
  credentials, queries, and fragments are rejected.
- Child processes use `shell: false`, a fixed executable and fixed argument list. Task prompts go to
  stdin and cannot add CLI arguments.
- Codex runs ephemeral with a read-only sandbox and `never` approval policy. Claude runs in plan
  mode with an empty tool list and no session persistence. Neither adapter can mutate a repository.
- Stdout, stderr, HTTP responses, task duration, request bodies, artifacts, and retry attempts are
  bounded. Every bridge control-plane request is cancelled after at most 30 seconds (or the shorter
  configured task timeout), and oversized streaming responses are cancelled as soon as they cross
  the byte ceiling. Subscription/local cost is persisted as `UNREPORTED` with a zero numeric
  placeholder, so unknown is never displayed or reasoned about as a confirmed free run.
- Process shutdown prevents new bridge requests and aborts registration, polling, heartbeats, and
  the current task. A lost heartbeat or lease prevents stale completion. A transport heartbeat
  failure is reported as retryable; an explicit durable cancellation remains non-retryable.
- Every claimed task must match the configured venue and provider. The execution prompt includes
  the exact initiating actor, agent identity, access/autonomy snapshot, operation/run references,
  scope, and attempt, while explicitly treating embedded task/scope text as untrusted data that
  cannot widen authority.

## Configuration

The HTTP route also requires the server-side `AGENT_BRIDGE_HTTP_ENABLED=true` rollout gate. The
selected venue credential must be active, unexpired, MCP-kind, and include `agent-runs:execute`.

Set these only in the local runner process environment:

```text
TORCHIKO_AGENT_BRIDGE_URL=https://<host>/api/agent-bridge/<tenant-id>/<venue-id>
TORCHIKO_AGENT_BRIDGE_SECRET=<one-time-issued-machine-secret>
TORCHIKO_AGENT_BRIDGE_VENUE_ID=<venue-id>
TORCHIKO_AGENT_BRIDGE_PROVIDER=CODEX_SUBSCRIPTION|CLAUDE_SUBSCRIPTION|HERMES|OPENAI_COMPATIBLE
TORCHIKO_AGENT_BRIDGE_LABEL=<operator-visible-label>
TORCHIKO_AGENT_BRIDGE_WORKDIR=<trusted-work-directory>
TORCHIKO_AGENT_BRIDGE_MODEL=subscription-default
TORCHIKO_AGENT_BRIDGE_WORKER_KEY=<stable-machine-worker-key>
TORCHIKO_AGENT_BRIDGE_WORKER_CAPABILITIES=<comma-separated-subset-of-credential-capabilities>
TORCHIKO_AGENT_BRIDGE_WORKER_AGENT_ROLES=<comma-separated-agent-identity-keys>
TORCHIKO_LOCAL_INFERENCE_URL=http://127.0.0.1:11434/v1
TORCHIKO_LOCAL_INFERENCE_KEY=<optional-loopback-server-key>
TORCHIKO_HERMES_PROFILE=<exact-installed-profile-name>
TORCHIKO_HERMES_MCP_URL=<optional-same-origin-MCP-endpoint>
```

`TORCHIKO_AGENT_BRIDGE_WORKER_KEY` is required and must uniquely identify this installed runner.
Use a new key when replacing its credential rather than silently rebinding an existing worker
identity. Capabilities default to the required `agent-runs:execute` capability and must remain a
subset of the issued credential; an explicit list that omits it is rejected locally. Agent roles
default to none. Role- or capability-bound runs are claimed only when the configured lists
explicitly match, so adding a worker does not silently widen its authority.

Then run `pnpm --filter @pathfinder/workers agent-bridge:run`. The runner verifies the work
directory and the selected subscription executable before it registers. It emits bounded JSON
status lines for `connected`, `idle`, task claim/completion/failure, unconfirmed failure recording,
and stop. Startup failures emit
a fixed `errorCode` such as `agent-bridge-invalid-secret`, `bridge-executor-unavailable`, or
`bridge-request-timeout`; they never include the credential or raw provider error text. The Control
Room remains the durable view of whether the latest heartbeat is online.

No real authenticated runner was
launched during implementation because no operator-issued deployment credential or rollout approval
was in scope. Run `pnpm test:agent-bridge:disposable` for provider-dark proof of authenticated HTTP,
session registration, rich claim context, retry/reclaim, completion, explicit cost provenance, and
durable artifact readback against a disposable migrated database with verified cleanup.

For Hermes, the runner derives the MCP endpoint by replacing `/api/agent-bridge/` in the bridge URL
with `/api/mcp/`. Set `TORCHIKO_HERMES_MCP_URL` only when the deployment uses a same-origin custom
route. The runner passes the existing machine credential as an HTTP `Authorization` header through
the ACP `session/new` MCP-server configuration; it is not placed in the Hermes prompt or runner
logs. Torchiko remains the authority boundary: the MCP route authenticates the credential and
exposes only the tools granted by that credential. Use a credential scoped to the intended venue
and capabilities; worker registration does not add MCP privileges.

## Provider status

| Provider                | Runner adapter       | Current authority                                                                                   |
| ----------------------- | -------------------- | --------------------------------------------------------------------------------------------------- |
| Codex subscription      | Implemented          | Ephemeral, read-only sandbox, no approvals                                                          |
| Claude subscription     | Implemented          | Plan-only, no tools, no persisted session                                                           |
| Hermes                  | Implemented over ACP | Named profile, authenticated same-origin Torchiko MCP, local filesystem/terminal permissions denied |
| OpenAI-compatible local | Implemented          | Loopback HTTP only, one leased task at a time                                                       |

The restricted first adapters prove safe subscription routing and result recovery. Repository-writing
Codex work and multi-run GPU scheduling remain out of scope. Hermes MCP tool use is available only
through the explicitly configured authenticated Torchiko MCP endpoint and still requires the
credential's existing capability and approval boundaries; it does not silently grant worker or model
permissions.
