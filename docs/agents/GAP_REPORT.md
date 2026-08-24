# Torchiko agent-operability gap report

Baseline date: 2026-08-21. Current-state reconciliation: 2026-08-23. This ledger preserves the
Packet A gaps but labels later closures instead of presenting the historical baseline as current
truth. See `company-brain-architecture.md` and the capability matrix for the implemented surface.

## P0 gaps

1. **Closed — standard MCP protocol transport.** Packet C added the authenticated, rate-limited,
   default-dark Streamable-HTTP-compatible route, MCP JSON-RPC `initialize`, `ping`, `tools/list`,
   and `tools/call` dispatch, bounded bodies, verified credential scope, and notification handling.
   Approval-bound machine attribution and the first governed write are also implemented. Broader
   write parity remains a policy/capability gap, not a transport gap.
2. **Agent/API parity is incomplete.** Torchiko's typed first-party API remains broader than the discoverable operational/prospect tools. Packet A added bounded report, conversation-session, integration-access, agent-run, event, deployment, and feature-flag reads; the visitor-answer quality loop adds separately gated evidence access for already-flagged public turns and review-only correction drafts. Agents can now create exact-scope private support drafts and, under separate evidence-backed one-use authorities, promote one existing draft from `DRAFT` to `OPEN` or append one attachment-free `INTERNAL_ONLY` note through canonical actions. Neither action can add participants, contact a customer, create client activity, change triage, execute work, or perform later lifecycle transitions. Agents can also create `NOTES`-only onboarding proposals, but cannot process files, extract or apply intake, publish, contact customers, grant participants, or resolve requests. Provider-specific and global AI control state is explicitly visible through bounded integration health, while broad conversation replay, venue lifecycle, file intake, report operations, incident mutation, and offboarding still lack adequate agent interfaces.
3. **Closed — prospect tool schema and discovery parity.** All eight authenticated prospect tools
   now expose strict input JSON Schemas, bounded output schemas, representative input/output
   examples, and validated related-tool links through both the runtime registry and
   `pnpm torchiko tools list --json`. The canonical contract adjunct is data-only and the discovery
   test fails closed if a schema, example, or related tool is missing. This improves composition
   metadata without adding send, approval, pricing, or customer-contact authority.
4. **Partially closed — resettable core database scenarios.** The four canonical provider-free venue worlds
   can now be created or reset through the developer interface in an already migrated exact-loopback
   `pathfinder_disposable_*` PostgreSQL database. Deterministic scenario-owned tenant, inactive venue,
   inactive place, and inactive structured-location rows are restored in one transaction while
   append-only content history remains intact. Exact marker and row-set checks refuse collisions or
   drift, and no provider is called. Degraded operations, rich-report state, and other
   domain-specific scenario layers remain incomplete and are not silently erased by the core reset.
5. **Closed — provider integration health baseline.** Agents can query one secret-free,
   tenant/venue-scoped projection across Gmail, billing, worker runtime, AI providers, embeddings,
   object storage, analytics, native deployment, and external worker access. The projection
   aggregates shared Gmail account failures, incorporates central provider-health exclusions,
   refuses to label embeddings healthy without persisted queue/completion evidence, derives storage
   health only from versioned object/verification records, and derives analytics health from scoped
   event, rollup, and latest pipeline-job outcomes. Version 2 also exposes explicit global AI
   admission state and active expiring provider exclusions while omitting incident reasons,
   operator identity, raw provider errors, and all recovery/mutation authority. Control read failure
   or malformed state is reported as fail-closed rather than silently healthy. Live provider probes
   and broader platform observability remain separate operational concerns.

## P1 gaps

1. **Partially closed — provider-free conversation assessment.** Synthetic replay preparation now
   includes fixture-owned match terms and location/hours evidence, and the developer interface can
   compare an answer supplied over bounded stdin with every required fact. It retains only the
   response digest and length, explains each lexical match or miss, never calls a provider, and
   exits nonzero on missing requirements. Arbitrary unsupported-claim detection, answer-usefulness
   judgment, provider-backed execution, provider trace explanation, and “why did the model do
   that?” remain incomplete.
2. **Closed — provider-free visitor configuration and scheduled-update simulation.** All four
   canonical worlds now include explicitly synthetic Bot/Voice configuration and operational
   update windows. The developer interface deterministically resolves requested-mode fallback and
   the canonical `DRAFT`/`INACTIVE`/`SCHEDULED`/`LIVE`/`EXPIRED` ordering, including exact start and
   expiry boundaries and the visitor-visible subset. It does not inspect live entitlements or
   environment flags and cannot schedule, publish, expire, or mutate an update.
3. **Partially closed — coherent report lifecycle read.** An exact `reports:read` tool now reuses
   the canonical report lifecycle query and returns generation/attempt state, persisted source
   counts, review state, publication/client visibility, explicit absence of modeled external
   delivery, and actor-free audit actions. It excludes report content, raw source artifacts, and
   provider errors. An exact-scope worker can now create or replay an internal draft-generation
   request through the same canonical action as the admin API, but only under live worker/run
   lineage, AI admission, enabled report configuration, and an evidence-backed bounded policy.
   It cannot edit, publish, deliver, or make the report client-visible. Regeneration of an existing
   report, exact source-artifact inspection, explanation of model choices, editing, publication,
   and real delivery operations remain gated or incomplete.
4. **Partially closed — operational control and job health.** Exact-scope agents can distinguish
   open, paused, malformed, and unavailable global AI admission plus active expiring provider
   exclusions through the real integration-health tool. The exact-venue jobs resource now adds an
   index-backed summary of persisted status/failure pressure and a shared, fail-closed worker
   heartbeat projection using the same freshness policy as administrator readiness. It explicitly
   distinguishes fresh, stale, malformed, and absent worker evidence and labels provider-disabled
   mode without claiming provider execution. A separately activated platform-worker capability now
   returns a canonical, complete 20-queue BullMQ/Redis aggregate with bounded depth, failed pressure,
   pause/scheduler state, and oldest nonterminal age; incomplete observation degrades readiness.
   Version 3 also fails closed on migration drift, stale worker evidence, disabled schedulers or
   provider work, paused queues, and canonical long-running work. The same compact projection is
   now visible in the mobile Founder Control Room. It intentionally supplies no tenant/venue
   attribution or job detail. The binding ledger no longer falsely maps AI-control reads to tenant
   feature flags. Tenant-attributed live queue state,
   external provider probes, broader deployment identity, incident reasons, control mutation, and
   automatic restoration remain partial or gated; empty persisted records are not called healthy.
5. **Partially closed — cost-protection observability.** The exact-venue `ai-usage` resource now
   returns daily usage/cost rollups together with the configured tenant hard-budget window,
   remaining/reserved/committed capacity, revision, and breach state. This makes the reviewed
   `admin.getAiCostBudget` bounded-alternative binding real instead of relying on usage rows alone.
   No anomaly threshold, automatic service suspension, budget mutation, customer pricing effect,
   operator reason, or operator identity is exposed or authorized. Pre-breach anomaly policy,
   infrastructure-wide cost aggregation, and external alert delivery remain unresolved or gated.
6. The platform-admin run workspace and the capability-gated MCP read surface now present actions,
   lifecycle events, approvals, and outcome observations as one bounded reverse-chronological
   exact-run trace. Raw payloads, scope snapshots, event data, and execution leases are
   intentionally excluded rather than treated as trace data.
7. **Partially closed — exact operation inventory and binding measurement.** The tool-coverage gate now
   statically walks the mounted router graph and records every exact tRPC path, query/mutation kind,
   defining router, source file, policy category, and inherited coverage decision. A reviewed
   count+SHA-256 inventory makes additions, removals, kind changes, ownership changes, and source
   moves fail closed, and a runtime test proves the static graph matches the authoritative mounted
   router. A second reviewed digest now maps 6 operations to direct tools, 105 to deliberately
   narrower alternatives, and leaves 294 explicitly unbound. Rules fail on duplicate/unknown
   operations, unknown surfaces, or tools that are merely declared but not bound in the safe
   runtime. This closes operation-level visibility and concrete binding measurement; it does not
   close the 294 measured parity gaps or convert a bounded alternative into exact UI/API parity.

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
- Expanded the same gate to 371 exact mounted operations with authoritative runtime equivalence,
  then added a reviewed exact binding ledger: 3 direct, 95 bounded alternatives, and 275 unbound.
  Declared-but-runtime-unbound tools cannot satisfy the ledger.
- Added four synthetic scenario fixtures with provider-free time/location simulation and conversation replay preparation.
- Added the initial capability matrix, developer guide, tool reference, and this gap ledger.
- Preserved all existing credential, outreach, billing, tenant, approval, publication, and production gates.

## Post-Packet-A closures

- Added the standards-shaped MCP JSON-RPC dispatcher and authenticated HTTP route at
  `/api/mcp/[tenantId]/[venueId]`, still default-dark behind `AGENT_BRIDGE_HTTP_ENABLED`.
- Added first-class machine actor, scoped approval-grant, and governed operational-update draft
  execution without granting broad autonomous mutation.
- Added canonical worker-evidence schema v2 across runs, actions, approval decisions, quality
  evaluations, and customer signals, plus one bounded operator trace over those evidence classes.
  Raw execution material remains deliberately gated.
