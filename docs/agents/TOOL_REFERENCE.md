# Torchiko agent tool reference

Generate the current machine-readable inventory with:

```powershell
pnpm torchiko tools list --json
```

The inventory normalizes core metadata across operational and prospect tools: capability, effect, approval or human-review boundary, idempotency, default state, transport, and canonical source.

The canonical operational schemas and security annotations are in `packages/contracts/src/mcp-v0.ts`. Server enforcement is in `packages/api/src/mcp/registry.ts`; concrete bounded reads are in `packages/api/src/mcp/read-actions.ts`. Prospect tools are defined and enforced in `packages/api/src/prospect-agent/registry.ts` and mounted through the authenticated agent bridge.

## Operational MCP

| Tool                                | Effect                              | Idempotency                | Approval                     | Default                                       |
| ----------------------------------- | ----------------------------------- | -------------------------- | ---------------------------- | --------------------------------------------- |
| `pathfinder.read`                   | Bounded client/venue resource read  | Safe repeat                | No                           | Enabled after verified credential composition |
| `pathfinder.ask_operator`           | Durable operator question           | Operation UUID             | No; never grants approval    | Enabled after verified credential composition |
| `pathfinder.delegate_specialist`    | Same-scope child agent run          | Operation UUID             | No domain mutation authority | Enabled after verified credential composition |
| `pathfinder.propose_billing_action` | Billing proposal only               | Operation UUID             | Downstream human approval    | Enabled after verified credential composition |
| `pathfinder.create_package_draft`   | Reviewable package draft            | Canonical action policy    | Verified approval grant      | Write tools default off                       |
| `pathfinder.create_update_draft`    | Reviewable operational-update draft | Canonical action policy    | Verified approval grant      | Write tools default off                       |
| `pathfinder.create_support_draft`   | Reviewable support draft            | Canonical action policy    | Verified approval grant      | Write tools default off                       |
| `pathfinder.request_evaluation`     | Bounded evaluation request          | Canonical request identity | Verified approval grant      | Write tools and runner default off            |
| `torchiko.account.get_context`      | Compact CRM/account context         | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.account.timeline`         | Paginated relationship timeline     | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.account.meetings`         | Bounded meeting summaries           | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.account.meeting_get`      | Exact meeting/extraction detail     | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.account.correspondence`   | Bounded correspondence snippets     | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.knowledge.search`         | Governed institutional search       | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.knowledge.get`            | Exact governed knowledge item       | Safe repeat                | No                           | Credential capability scoped                  |
| `torchiko.integrations.health`      | Secret-free integration health      | Safe repeat                | No                           | Credential capability scoped                  |

`pathfinder.read` supports clients, billing, venues, configuration, content, history, packages, support, updates, AI usage, jobs, evaluations, weekly reports, privacy-bounded conversation sessions, integration access health, agent runs, operational events, native deployments, feature flags, onboarding summary, readiness, questions, and outcomes. Every query reapplies verified tenant/client/venue scope and returns bounded projections rather than raw payloads or secrets.

The expanded operational-intelligence resources deliberately exclude report content/errors, visitor tokens and coordinates, message bodies, credential hashes/prefixes, agent prompts/scope snapshots/artifacts, deployment plans/state hashes, and feature-flag metadata/actor IDs.

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
