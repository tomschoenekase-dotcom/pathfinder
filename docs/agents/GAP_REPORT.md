# Torchiko agent-operability gap report

Baseline date: 2026-08-21. This report is updated as Packet A closes gaps.

## P0 gaps

1. **Operational MCP is not composed as a deployable authenticated service.** The contracts, registry, reads, approval seam, credential schema, and default-dark agent bridge exist, but the MCP registry has no production composition root or protocol dispatcher.
2. **Agent/API parity is incomplete.** Torchiko's typed first-party API is much broader than the 13 currently discoverable operational/prospect tools. Venue lifecycle, intake, reports, conversations, integrations, offboarding, and broad system intelligence lack agent interfaces.
3. **Tool metadata is split.** MCP definitions are rich and machine-readable; prospect definitions expose only name/capability/mutation. A unified catalog needs consistent arguments, outputs, permissions, side effects, environments, approval, idempotency, examples, and related tools.
4. **No reusable data-scenario framework.** Visual fixtures and the Golden Venue contract exist, but named resettable database scenarios such as minimal venue, degraded operations, rich report, or support escalation are not implemented.
5. **No unified integration-health registry.** Configuration and credential surfaces exist, but agents cannot safely query configured/healthy/last-success/last-failure capability projections across providers.

## P1 gaps

1. Conversation replay, expected/actual comparison, grounding explanation, and “why did the AI do that?” are not exposed through one developer interface.
2. Location, time, scheduled-update, and client-configuration simulation remain scattered across tests rather than reusable scenarios.
3. Report generation/regeneration, source inspection, explanation, and delivery status lack a coherent agent namespace.
4. System jobs, queues, migrations, service health, integration health, feature flags, and deployment identity are only partially visible to agents.
5. Agent activity is visible in existing admin workspaces, but tool calls and changes are not yet presented as one unified run trace.
6. Tool coverage CI does not yet fail when a significant new admin capability lacks an agent/developer coverage decision.

## Intentionally restricted or deferred

- Final prospect-email approval and sending remain human-controlled.
- Stripe writes, customer access changes, production billing rollout, and live-mode enablement remain human-controlled.
- Package publication, destructive bulk actions, account deletion, production-sensitive configuration, credential issuance, and offboarding finalization require explicit authority and may remain non-autonomous.
- Provider-backed and external staging proof cannot be claimed from local tests.
- Browser automation remains a justified E2E/third-party fallback, not the normal product-operation interface.

## Packet A progress

- Implemented the inspect-only `pnpm torchiko` developer entry point for bootstrap, environment doctor, repository mapping, tool discovery, fixture discovery, targeted-test discovery, and Golden Venue validation.
- Added the initial capability matrix, developer guide, tool reference, and this gap ledger.
- Preserved all existing credential, outreach, billing, tenant, approval, publication, and production gates.
