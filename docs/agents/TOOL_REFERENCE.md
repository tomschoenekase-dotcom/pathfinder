# Torchiko agent tool reference

Generate the current machine-readable inventory with:

```powershell
pnpm torchiko tools list --json
```

The inventory normalizes core metadata across operational and prospect tools: capability, effect, approval or human-review boundary, idempotency, default state, transport, and canonical source.

The canonical operational schemas and security annotations are in `packages/contracts/src/mcp-v0.ts`. Server enforcement is in `packages/api/src/mcp/registry.ts`; concrete bounded reads are in `packages/api/src/mcp/read-actions.ts`. Prospect tools are defined and enforced in `packages/api/src/prospect-agent/registry.ts` and mounted through the authenticated agent bridge.

## Operational MCP

| Tool                                          | Effect                                  | Idempotency                | Approval                                  | Default                                         |
| --------------------------------------------- | --------------------------------------- | -------------------------- | ----------------------------------------- | ----------------------------------------------- |
| `pathfinder.read`                             | Bounded client/venue resource read      | Safe repeat                | No                                        | Enabled after verified credential composition   |
| `pathfinder.ask_operator`                     | Durable operator question               | Operation UUID             | No; never grants approval                 | Enabled after verified credential composition   |
| `pathfinder.delegate_specialist`              | Same-scope child agent run              | Operation UUID             | No domain mutation authority              | Enabled after verified credential composition   |
| `pathfinder.propose_billing_action`           | Billing proposal only                   | Operation UUID             | Downstream human approval                 | Enabled after verified credential composition   |
| `pathfinder.create_package_draft`             | Reviewable package draft                | Canonical action policy    | Verified approval grant                   | Write tools default off                         |
| `pathfinder.create_update_draft`              | Reviewable operational-update draft     | Canonical action policy    | Verified approval grant                   | Write tools default off                         |
| `pathfinder.create_support_draft`             | Reviewable support draft                | Canonical action policy    | Verified approval grant                   | Write tools default off                         |
| `pathfinder.request_evaluation`               | Bounded evaluation request              | Canonical request identity | Verified approval grant                   | Write tools and runner default off              |
| `torchiko.account.get_context`                | Compact CRM/account context             | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.account.timeline`                   | Paginated relationship timeline         | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.account.meetings`                   | Bounded meeting summaries               | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.account.meeting_get`                | Exact meeting/extraction detail         | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.meeting.process`                    | Candidate extraction + completion       | Operation UUID             | No; promotion remains separate            | Live worker/run + capability scoped             |
| `torchiko.account.correspondence`             | Bounded correspondence snippets         | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.knowledge.search`                   | Governed institutional search           | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.knowledge.get`                      | Exact governed knowledge item           | Safe repeat                | No                                        | Credential capability scoped                    |
| `torchiko.customer_access.prepare_invitation` | Provider-dark member invitation request | Operation UUID             | Founder review before any external effect | Live worker/run + exact owner-authored evidence |
| `torchiko.integrations.health`                | Secret-free integration health          | Safe repeat                | No                                        | Credential capability scoped                    |

`pathfinder.read` supports clients, billing, venues, configuration, content, history, packages, support, updates, AI usage, jobs, evaluations, weekly reports, privacy-bounded conversation sessions, integration access health, agent runs, an exact-run unified trace, operational events, native deployments, feature flags, onboarding summary, readiness, questions, and outcomes. Every query reapplies verified tenant/client/venue scope and returns bounded projections rather than raw payloads or secrets. `agent-run-trace` additionally requires `agentRunId`, uses the existing `agent-runs:read` capability, and merges only safe action, lifecycle, approval, and outcome evidence.

`torchiko.knowledge.list_gaps` is a separately gated `conversations:review` projection. It exposes only bounded question/answer evidence from already-flagged public turns; it does not expose visitor identity, retained location, or broad conversation replay. `torchiko.knowledge.propose_correction` requires `knowledge:draft`, a live credential-bound worker, and a live scoped run. It can create one evidence-linked `PENDING_REVIEW` proposal, but cannot edit, retire, publish, or re-embed canonical knowledge.

`torchiko.customer_access.prepare_invitation` requires `customer-access:prepare`, a live credential-bound worker and run, and one exact client-visible support message authored by an active organization owner. It normalizes and de-duplicates a member email, records a high-risk approval request plus full agent lineage, and moves the run to `AWAITING_APPROVAL`. It does not call Clerk, send email, create a user, or change membership; provider execution remains a separate unimplemented and gated action.

The expanded operational-intelligence resources deliberately exclude report content/errors, visitor tokens and coordinates, message bodies, credential hashes/prefixes, agent prompts/scope snapshots/artifacts, deployment plans/state hashes, and feature-flag metadata/actor IDs.

## Operation coverage evidence

`pnpm torchiko tools coverage --json` is the machine-readable comparison surface between the typed
first-party API and agent policy. It inventories exact mounted tRPC operations, not just router
names, and fails when its reviewed operation digest drifts. Each entry includes the operation path,
kind, defining router, source file, policy category, and inherited agent/developer coverage. The
inherited `partial` label describes the domain policy only; it does not claim an exact MCP binding.
Use the MCP resource/tool catalog above to verify actual callable agent interfaces.

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

Canonical actions now support honest human, machine, system, and integration attribution. The operational-update draft is the first enabled approval-bound machine write and consumes an exact verified grant; package, support, evaluation, publication, outreach, billing-effect, deployment, and destructive writes retain their stricter controls. The same registry is exposed through the authenticated bridge and the standards MCP JSON-RPC route at `/api/mcp/[tenantId]/[venueId]`.
