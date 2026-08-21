# Torchiko agent-operability gap report

Baseline date: 2026-08-21. This report is updated as Packet A closes gaps.

## P0 gaps

1. **Operational MCP is not composed as a deployable authenticated service.** The contracts, registry, reads, approval seam, credential schema, and default-dark agent bridge exist, but the MCP registry has no production composition root or protocol dispatcher.
2. **Agent/API parity is incomplete.** Torchiko's typed first-party API is much broader than the 13 currently discoverable operational/prospect tools. Packet A has added bounded report, conversation-session, integration-access, agent-run, event, deployment, and feature-flag reads, but venue lifecycle, intake, report operations, conversation replay, provider health, and offboarding still lack adequate agent interfaces.
3. **Tool metadata is split.** MCP definitions are rich and machine-readable; prospect definitions expose only name/capability/mutation. A unified catalog needs consistent arguments, outputs, permissions, side effects, environments, approval, idempotency, examples, and related tools.
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
- Added `pnpm verify:agent-tools`, which fails when a mounted application/admin router has no explicit or has an ambiguous agent/developer coverage decision.
- Added four synthetic scenario fixtures with provider-free time/location simulation and conversation replay preparation.
- Added the initial capability matrix, developer guide, tool reference, and this gap ledger.
- Preserved all existing credential, outreach, billing, tenant, approval, publication, and production gates.
