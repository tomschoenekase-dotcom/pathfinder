# Torchiko agent-operability gap report (Packet A historical baseline)

Baseline date: 2026-08-21. The numbered gaps below preserve Packet A's final baseline. Packet C / Company Brain subsequently closed standard MCP transport, verified approval-bound machine attribution and the first canonical write, disposable database scenarios, unified integration health, provider-routed grounding evaluation infrastructure, and durable explanation evidence. See `company-brain-architecture.md` and the current capability matrix for implemented state.

## P0 gaps

1. **Standard MCP protocol transport remains incomplete.** Packet A now provides a safe production composition root and mounts operational discovery/calls on the authenticated, rate-limited, default-dark agent bridge. A standards-compliant MCP JSON-RPC dispatcher and approval-bound machine-write bindings remain deferred.
2. **Agent/API parity is incomplete.** Torchiko's typed first-party API remains broader than the discoverable operational/prospect tools. Packet A added bounded report, conversation-session, integration-access, agent-run, event, deployment, and feature-flag reads; the visitor-answer quality loop now adds separately gated evidence access for already-flagged public turns and review-only correction drafts. Broad conversation replay, venue lifecycle, intake, report operations, provider health, and offboarding still lack adequate agent interfaces.
3. **Tool metadata has a common core but not full schema parity.** Operational and prospect tools now expose effect, capability, review/approval, idempotency, default state, and transport through `pnpm torchiko tools list --json`. Prospect tools still need formal input/output JSON Schemas, examples, and related-tool links for complete parity with MCP definitions.
4. **Resettable database scenarios remain incomplete.** Packet A now supplies four provider-free synthetic venue scenarios and deterministic time/location/replay contracts, but database-backed create/reset operations such as degraded operations, rich report, or support escalation are not implemented.
5. **Provider integration health remains fragmented.** Agents can now query safe venue-scoped access-credential configuration and last-use state, but configured/healthy/last-success/last-failure projections across email, storage, payments, models, analytics, and workers are not unified.

## P1 gaps

1. Synthetic conversation replay preparation is available through the developer interface; provider-backed execution, expected/actual comparison, grounding explanation, and “why did the AI do that?” remain incomplete.
2. Deterministic location and time simulation are reusable across four scenario shapes; scheduled-update and client-configuration simulation remain incomplete.
3. Report generation/regeneration, source inspection, explanation, and delivery status lack a coherent agent namespace.
4. System jobs, queues, migrations, service health, integration health, feature flags, and deployment identity are only partially visible to agents.
5. Agent activity is visible in existing admin workspaces, but tool calls and changes are not yet presented as one unified run trace.
6. The new tool-coverage CI gate classifies mounted routers, but it does not yet measure operation-level parity within each router.

## Intentionally restricted or deferred

- Final prospect-email approval and sending remain human-controlled.
- Stripe writes, customer access changes, production billing rollout, and live-mode enablement remain human-controlled.
- Package publication, destructive bulk actions, account deletion, production-sensitive configuration, credential issuance, and offboarding finalization require explicit authority and may remain non-autonomous.
- Provider-backed and external staging proof cannot be claimed from local tests.
- Browser automation remains a justified E2E/third-party fallback, not the normal product-operation interface.

## Packet A progress

- Implemented the inspect-only `pnpm torchiko` developer entry point for bootstrap, environment doctor, repository mapping, tool discovery, fixture discovery, targeted-test discovery, and Golden Venue validation.
- Expanded the existing `pathfinder.read` surface with permission-scoped, paginated, privacy-bounded reports, conversations, integration access, agent runs, operational events, native deployments, and feature flags.
- Composed the safe operational catalog through the existing agent bridge with credential-derived scope; approval-bound writes remain default-dark.
- Unified core discovery metadata across operational MCP and prospect-agent tools.
- Added `pnpm verify:agent-tools`, which fails when a mounted application/admin router has no explicit or has an ambiguous agent/developer coverage decision.
- Added four synthetic scenario fixtures with provider-free time/location simulation and conversation replay preparation.
- Added the initial capability matrix, developer guide, tool reference, and this gap ledger.
- Preserved all existing credential, outreach, billing, tenant, approval, publication, and production gates.
