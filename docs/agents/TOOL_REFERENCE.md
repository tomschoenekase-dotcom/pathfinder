# Torchiko agent tool reference

Generate the current machine-readable inventory with:

```powershell
pnpm torchiko tools list --json
```

The inventory normalizes core metadata across operational and prospect tools: capability, effect, approval or human-review boundary, idempotency, default state, runtime availability, transport, and canonical source. `bound` means the safe runtime has a concrete domain binding; `declared-unbound` means only the reviewed contract exists and calls still fail closed.

The canonical operational schemas and security annotations are in `packages/contracts/src/mcp-v0.ts`. Server enforcement is in `packages/api/src/mcp/registry.ts`; concrete bounded reads are in `packages/api/src/mcp/read-actions.ts`. Prospect tools are defined and enforced in `packages/api/src/prospect-agent/registry.ts`, their data-only input/output schemas, examples, and related-tool links are in `packages/api/src/prospect-agent/tool-contracts.json`, and they are mounted through the authenticated agent bridge. The registry and developer inventory both consume that same contract adjunct.

## Operational MCP

| Tool                                          | Effect                                   | Idempotency                | Approval                                  | Default                                          |
| --------------------------------------------- | ---------------------------------------- | -------------------------- | ----------------------------------------- | ------------------------------------------------ |
| `pathfinder.read`                             | Bounded client/venue resource read       | Safe repeat                | No                                        | Enabled after verified credential composition    |
| `pathfinder.ask_operator`                     | Durable operator question                | Operation UUID             | No; never grants approval                 | Enabled after verified credential composition    |
| `pathfinder.delegate_specialist`              | Same-scope child agent run               | Operation UUID             | No domain mutation authority              | Enabled after verified credential composition    |
| `pathfinder.propose_billing_action`           | Billing proposal only                    | Operation UUID             | Downstream human approval                 | Enabled after verified credential composition    |
| `pathfinder.create_package_draft`             | Reviewable package draft                 | Canonical action policy    | Verified approval grant                   | Declared; no safe-runtime binding                |
| `pathfinder.create_update_draft`              | Reviewable operational-update draft      | Canonical action policy    | Verified approval grant                   | Bound; exact grant still required                |
| `pathfinder.create_support_draft`             | Private internal support draft           | Operation UUID             | Verified approval grant                   | Bound; opening is a separate authority           |
| `pathfinder.open_support_request`             | One internal `DRAFT` → `OPEN` transition | Operation UUID             | Evidence-backed one-use approval          | Bound; no participant/message/customer contact   |
| `pathfinder.add_support_internal_note`        | One attachment-free internal note        | Operation UUID             | Evidence-backed one-use approval          | Bound; no client activity or lifecycle change    |
| `pathfinder.create_intake_notes_proposal`     | Reviewable onboarding-notes proposal     | Operation UUID             | Verified approval grant                   | Bound; extraction/application remain separate    |
| `pathfinder.request_evaluation`               | Bounded evaluation request               | Canonical request identity | Verified approval grant                   | Declared; no safe-runtime binding                |
| `torchiko.account.get_context`                | Compact CRM/account context              | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.account.timeline`                   | Paginated relationship timeline          | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.account.meetings`                   | Bounded meeting summaries                | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.account.meeting_get`                | Exact meeting/extraction detail          | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.meeting.process`                    | Candidate extraction + completion        | Operation UUID             | No; promotion remains separate            | Live worker/run + capability scoped              |
| `torchiko.account.correspondence`             | Bounded correspondence snippets          | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.knowledge.search`                   | Governed institutional search            | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.knowledge.get`                      | Exact governed knowledge item            | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.locations.propose_draft`            | Typed location proposal only             | Operation UUID             | Human review, then separate application   | Live worker/run + exact venue scope              |
| `torchiko.customer_access.prepare_invitation` | Provider-dark member invitation request  | Operation UUID             | Founder review before any external effect | Live worker/run + exact owner-authored evidence  |
| `torchiko.integrations.health`                | Secret-free integration/control health   | Safe repeat                | No                                        | Credential capability scoped                     |
| `torchiko.reports.get_lifecycle`              | Exact weekly-report lifecycle            | Safe repeat                | No                                        | Exact venue/report and `reports:read` scoped     |
| `pathfinder.generate_weekly_report_draft`     | Internal report draft generation         | Idempotent operation ID    | Yes; evidence-backed grant                | Exact venue and `reports:draft`; never publishes |

`pathfinder.read` supports clients, billing, venues, configuration, content, history, packages, support, updates, AI usage and cost protection, jobs, evaluations, weekly reports, privacy-bounded conversation sessions, integration access health, agent runs, an exact-run unified trace, operational events, native deployments, feature flags, onboarding summary, readiness, questions, and outcomes. Every query reapplies verified tenant/client/venue scope and returns bounded projections rather than raw payloads or secrets. `agent-run-trace` additionally requires `agentRunId`, uses the existing `agent-runs:read` capability, and merges only safe action, lifecycle, approval, and outcome evidence.

The venue-scoped `readiness` projection additionally reports secret-free native guest-read
preflight and convergence alignment. It requires `readiness:read`; release/evidence identifiers,
policy-reference strings, state hashes, and production identity remain excluded. This observation
surface cannot activate the read path or certify quality/production approval.

`torchiko.knowledge.list_gaps` is a separately gated `conversations:review` projection. It exposes only bounded question/answer evidence from already-flagged public turns; it does not expose visitor identity, retained location, or broad conversation replay. `torchiko.knowledge.propose_correction` requires `knowledge:draft`, a live credential-bound worker, and a live scoped run. It can create one evidence-linked `PENDING_REVIEW` proposal, but cannot edit, retire, publish, or re-embed canonical knowledge.

`torchiko.customer_access.prepare_invitation` requires `customer-access:prepare`, a live credential-bound worker and run, and one exact client-visible support message authored by an active organization owner. It normalizes and de-duplicates a member email, records a high-risk approval request plus full agent lineage, and moves the run to `AWAITING_APPROVAL`. It does not call Clerk, send email, create a user, or change membership; provider execution remains a separate unimplemented and gated action.

`pathfinder.create_support_draft` requires `support:draft`, a live credential-bound worker and
run, and an exact verified approval grant. It creates one venue-scoped `DRAFT` request with an
`INTERNAL_ONLY` first message and complete audit/grant lineage. The customer requester is null,
no participant is granted, and no client version or activity marker is written for the private
message. Subject/body bounds
and allowed categories are enforced by the registered policy evaluator, and rejected attempts do
not consume a policy use.

`pathfinder.open_support_request` requires the separate `support:open` capability, live
credential-bound worker/run lineage, an evidence-backed policy fixed to one use, the exact request
version, and an existing `DRAFT`. It reuses the canonical support status action and may produce
only `OPEN`. The operation is replay-safe and audited; it does not change client activity, add a
participant or message, contact a customer, execute a package, or authorize any later transition.
Human operators retain cancellation and the rest of the support lifecycle.

`pathfinder.add_support_internal_note` requires the separate `support:note` capability, a live
credential-bound worker/run, an evidence-backed policy fixed to one use, and the exact request
version. It reuses the canonical support-message action but fixes visibility to `INTERNAL_ONLY`
and attachments to empty. It is replay-safe, keeps client version/activity unchanged, and cannot
contact a customer, add a participant, change status or triage, or execute package lifecycle work.

`pathfinder.create_intake_notes_proposal` requires `intake:draft`, a live credential-bound worker
and run, and an exact verified approval grant. It creates only a `NOTES` intake run in
`AWAITING_REVIEW` with complete run, worker, credential, grant, model, and idempotency lineage.
The registered evaluator enforces exact client/venue scope and the reviewed notes bound. It does
not extract content, create or apply a venue package, publish venue content, or contact a customer.

`torchiko.locations.propose_draft` requires `locations:propose`, a live credential-bound worker and run, exact venue scope, and a typed location payload. It validates current floor/parent references, records bounded evidence and a medium-risk approval item, and changes no venue content. Approval executes nothing. A separate platform-admin action may apply the exact approved payload as an inactive draft; activation remains another distinct human review.

Floor and connection draft/edit/availability procedures are platform-admin operations with exact tenant/venue scope, revision checks, dependency guards, venue-content locking, and strict audit evidence. They are deliberately unbound from agent tools; the current agent proposal contract covers anchors only and does not compute or publish routes.

The expanded operational-intelligence resources deliberately exclude report content/errors, visitor tokens and coordinates, message bodies, credential hashes/prefixes, agent prompts/scope snapshots/artifacts, deployment plans/state hashes, and feature-flag metadata/actor IDs.

`torchiko.reports.get_lifecycle` reuses the canonical administrator lifecycle query for one exact
report, then returns a machine-readable safe projection of generation state, persisted source
counts, review status, publication/client visibility, explicit absence of external-delivery state,
and actor-free audit actions. It exposes only failure-presence booleans—not raw report, dispatch, or
job errors—and grants no generation, editing, publication, or delivery authority.

`torchiko.integrations.health` schema v2 adds explicit provider-dark incident-readiness evidence to
the existing exact client/venue integration projection. It reports global AI admission as open,
paused, malformed, or unavailable and lists only active provider IDs with their bounded expiry. A
control read failure or malformed record is visible as fail-closed rather than healthy. Human
incident reasons, operator identity, raw provider errors, control mutation, and automatic recovery
authority are excluded. Global/provider control reads are bound here, not to the tenant
`feature-flags` resource.

The `ai-usage` resource returns exact-venue daily token, request, failure, and estimated-cost
rollups plus the configured tenant `gateway-v1` hard-budget state. Budget values use exact fixed
eight-decimal USD strings and distinguish not configured, disabled, scheduled, active, exhausted,
expired, and breached state without inventing an anomaly threshold. Operator reason and identity
are excluded. The resource cannot reset, enable, increase, or otherwise mutate the budget; it does
not authorize service suspension, change customer pricing, or turn estimated cost into an invoice.

The `jobs` resource schema v2 keeps execution payloads and errors private while returning an
index-backed exact-venue summary of persisted running, completed, and failed records, terminal
failure dispositions, and a diagnostic count of runs older than the canonical 15-minute
operational observation boundary. It also reuses the administrator readiness projection for the
persisted worker heartbeat, including fresh, stale, malformed, and not-observed states plus
provider-enabled/provider-disabled mode, scheduler declaration, and revision. This does not query
Redis, prove queue depth, prove provider execution, establish an SLO, or grant retry, cancellation,
redrive, or incident-control authority. An empty persisted result is explicitly not evidence that
the live queue or service is healthy.

Separately, an explicitly activated `pf_platform_` credential with
`operations-readiness:read` may call `POST /api/platform-worker/operations-readiness`. That
platform-wide v3 view observes all canonical BullMQ queues directly from Redis and returns bounded
counts, depth, retained failed pressure, pause/scheduler state, and oldest nonterminal age. Overall
readiness now fails closed on migration drift, stale worker evidence, disabled schedulers or
provider work, incomplete queue coverage, any paused queue, or canonical long-running work. It has
no tenant/venue attribution, job identity, payload, failure detail, retry/redrive/incident control,
provider-execution/storage/scanner/email proof, or SLO authority. The Founder Control Room renders
the same bounded projection. This does not widen the tenant MCP `jobs` resource.

## Operation coverage evidence

`pnpm torchiko tools coverage --json` is the machine-readable comparison surface between the typed
first-party API and agent policy. It inventories exact mounted tRPC operations, not just router
names, and fails when either its reviewed operation digest or reviewed binding digest drifts. Each
entry includes the operation path, kind, defining router, source file, policy category, inherited
agent/developer coverage, and exact binding state. The current 404-operation inventory contains 6
direct-tool bindings, 104 bounded alternatives, and 294 explicit unbound gaps. A binding is rejected
if its operation is missing/duplicated, its surface is unknown, or its tool is declared but not
bound in `createSafeOperationalMcpRegistry`. The inherited `partial` label remains domain policy,
not callable proof.

## Prospect agent tools

| Tool                                       | Capability           | Effect                                 | Safety boundary                                     |
| ------------------------------------------ | -------------------- | -------------------------------------- | --------------------------------------------------- |
| `torchiko.prospects.search`                | `prospects.read`     | Bounded organization search            | Frozen run scope intersected with live identity     |
| `torchiko.prospects.get_intelligence`      | `prospects.read`     | CRM and linked live-venue intelligence | Exact tenant and territory scope                    |
| `torchiko.prospects.list_campaign_members` | `prospects.read`     | Bounded campaign membership            | Exact organization scope                            |
| `torchiko.prospects.save_outreach_draft`   | `prospects.draft`    | Grounded versioned draft               | Cannot approve, queue, send, unsuppress, or convert |
| `torchiko.prospects.ask_operator`          | `prospects.question` | Durable operator question              | Cannot grant approval or execute outreach           |

## Transport truth

The safe operational catalog is composed through `createSafeOperationalMcpRegistry` and mounted on the existing authenticated, rate-limited, default-dark agent bridge as `listOperationalTools` and `callOperationalTool`. The bridge derives client and venue scope from its verified machine credential and overwrites caller-supplied scope. Reads, operator questions, specialist delegation, and billing proposals reuse canonical domain actions.

Canonical actions now support honest human, machine, system, and integration attribution. Operational-update, private support, and onboarding-notes proposals are enabled approval-bound machine writes and consume exact verified grants. Separate one-use support authorities permit one exact existing draft to move from `DRAFT` to `OPEN` or one attachment-free `INTERNAL_ONLY` note to be appended; neither can add participants, contact a customer, create client activity, change triage, execute work, or perform later transitions. Intake extraction/package application, package and evaluation execution, publication, outreach, billing effects, deployment, customer contact, and destructive writes retain their stricter controls. The same registry is exposed through the authenticated bridge and the standards MCP JSON-RPC route at `/api/mcp/[tenantId]/[venueId]`.
