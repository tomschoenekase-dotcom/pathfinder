# Torchiko agent-native workspace

## Product direction

Torchiko should be usable primarily as a conversation with a trusted team of agents. The visual
interface remains the authoritative place to understand scope, answer questions, approve risky
work, inspect evidence, and recover from failures. It should not require an operator to translate
between chat, hidden agent state, and administrative screens.

The operating loop is:

1. The operator gives a goal to a primary agent.
2. The primary agent chooses a scoped specialist and creates a durable run.
3. Specialists use MCP resources for context and canonical domain tools for work.
4. Missing context appears in **Needs your input**; risky actions appear separately in approvals.
5. The operator answers once. A connected worker resumes from durable state.
6. Results, cost, artifacts, and failures remain visible in the run timeline.

Questions and approvals are deliberately different. An answer supplies context; it never grants
authority. Approval grants one reviewed action; it never supplies broad autonomy.

## Implemented

- Fourteen scoped MCP resource families, including agent questions and explicit outcome evidence.
- Seven MCP tools, including `pathfinder.ask_operator` and the idempotent,
  scope-bound `pathfinder.delegate_specialist` interaction.
- Durable, idempotent questions linked to agent identity and optionally a run.
- `AWAITING_INPUT` run state and safe return to `QUEUED` after an answer.
- A first-class Agent workspace inbox with suggested answers and free-form responses.
- A human task composer that records and dispatches an idempotent scoped run when the separately
  controlled agent runtime is enabled.
- BullMQ consumption behind `AGENT_RUNNER_ENABLED`, with atomic Postgres leases, heartbeats,
  cancellation observation, bounded attempts, stale-lease takeover, and durable completion or
  failure evidence.
- Budgeted Anthropic execution through the existing venue admission, usage, and cost-reservation
  boundaries. The worker supports safe text analysis and drafting; it does not claim tool use.
- Explicit provider targets for Anthropic, Hermes, Codex subscription, Claude subscription, and
  local OpenAI-compatible bridges. Bridge targets fail truthfully until a local runner is connected.
- Provider/model configuration and explicit enable/disable controls for specialist identities.
- Primary-agent to specialist child runs with parent/child lineage and timelines on both runs.
- Operator-visible prompts, text result artifacts, retry/heartbeat state, and specialist lineage on
  run detail. Raw action payloads, scope snapshots, and lease tokens remain hidden.
- One mobile-friendly, read-only run trace merges bounded action summaries, lifecycle events,
  approval history, and outcome evidence in exact reverse chronology with a heterogeneous cursor.
- An append-only run conversation combining operator prompts, agent questions, operator answers,
  and agent results. Answering a blocking question dispatches a new resume job when the runtime is
  enabled.
- A transport-neutral authenticated bridge registry for registration, presence heartbeat, exact
  provider/model task claims, run heartbeats, bounded artifacts, completion, and failure. Sessions
  are backed by revocable venue-scoped MCP machine credentials and expire after missed heartbeats.
- A default-dark authenticated HTTP bridge composition root with bounded request/response bodies,
  pre-hash rate limiting, exact tenant/venue scoping, and non-secret errors.
- A desktop bridge runner for read-only Codex subscription work, plan-only Claude subscription
  work, deny-by-default named-profile Hermes ACP work, and single-task OpenAI-compatible loopback
  inference. It renews both session and task leases, observes cancellation, and posts bounded
  durable results.
- Live runner observability and a strictly audited disconnect control in the Integrations section.
- Dedicated Agent Integration and AI Controls pages showing actual lease-backed readiness,
  specialist-to-provider assignments, runtime gating, budget/model links, and safety boundaries.
- Tenant, client, venue, identity, and run scope validation at every boundary.
- Optimistic concurrency, timeline evidence, and strict audit logging for operator responses.
- Draft and evaluation tools remain default-off and require exact approval evidence.

## Next execution layers

These are intentionally not represented as complete:

- Production deployment and operational smoke evidence for the authenticated bridge route. The
  composition root exists behind `AGENT_BRIDGE_HTTP_ENABLED`, but this change does not claim a
  deployed listener.
- Reviewed, role-specific Hermes tool permission mappings. The named-profile ACP adapter exists but
  deliberately denies all permission requests until those mappings are explicit; no subscription
  credentials are stored by Torchiko.
- Automatic capability/model/budget scoring when a primary agent has several eligible specialists.
- Free-form multi-turn operator/agent chat beyond the durable prompt, question, answer, status, and
  result message types already retained on each run.
- Notifications that link back to the same durable question or approval.
- Staging adversarial tests and deployment evidence. The HTTP route already applies bounded
  in-process authentication-attempt limiting; distributed edge limits remain a deployment concern.

The disposable-database end-to-end smoke now proves credential issuance, activation, session
registration, task claim, heartbeat, completion, and artifact readback across all 98 migrations. The
next safe vertical slice is staging rollout with deployment-specific edge rate limits and explicit
permission mappings for any Hermes tool beyond the current deny-all ACP adapter. It must continue to
use scoped, revocable machine credentials and never browser-profile or subscription-token scraping.
