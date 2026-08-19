# Torchiko desktop agent bridge runner

Status: implemented and tested; default-dark; not launched or authenticated by this change.

The runner connects a single local Claude Code or Codex CLI process to one exact Torchiko venue. It
polls the authenticated bridge endpoint, executes one leased task at a time, sends 25-second task
heartbeats, observes durable cancellation, and posts a bounded Markdown artifact or a non-secret
failure code. A session heartbeat expires after two minutes if the process disappears.

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
  bounded. Subscription cost is reported as unknown/zero rather than invented.
- Process shutdown aborts the current task. A lost heartbeat or lease prevents stale completion.

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
TORCHIKO_LOCAL_INFERENCE_URL=http://127.0.0.1:11434/v1
TORCHIKO_LOCAL_INFERENCE_KEY=<optional-loopback-server-key>
TORCHIKO_HERMES_PROFILE=<exact-installed-profile-name>
```

Then run `pnpm --filter @pathfinder/workers agent-bridge:run`. No real authenticated runner was
launched during implementation because no operator-issued deployment credential or rollout approval
was in scope. The credential, session, claim, heartbeat, completion, and artifact lifecycle was
proved separately against a disposable pgvector PostgreSQL database.

## Provider status

| Provider                | Runner adapter       | Current authority                               |
| ----------------------- | -------------------- | ----------------------------------------------- |
| Codex subscription      | Implemented          | Ephemeral, read-only sandbox, no approvals      |
| Claude subscription     | Implemented          | Plan-only, no tools, no persisted session       |
| Hermes                  | Implemented over ACP | Named profile, stdin prompt, permissions denied |
| OpenAI-compatible local | Implemented          | Loopback HTTP only, one leased task at a time   |

The restricted first adapters prove safe subscription routing and result recovery. Repository-writing
Codex work, permissioned Hermes tools, multi-run GPU scheduling, and MCP tool injection require
separate explicit authority mappings rather than silently widening this runner.
