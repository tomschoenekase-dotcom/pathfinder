# Torchiko agent tool reference

Generate the current machine-readable inventory with:

```powershell
pnpm torchiko tools list --json
```

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

The registry contract alone is not a deployed MCP service. Operational MCP composition still requires a verified credential provider, rate limiting, audit transport evidence, and an enabled listener. The agent bridge HTTP route and desktop runner are separately default-dark and scoped to exact machine credentials, venues, live sessions, and leased runs.
