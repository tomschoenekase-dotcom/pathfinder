# Company Brain final verification

Verified 2026-08-21 on branch `codex/torchiko-company-brain-20260821`, based directly on Packet A commit `0723ef0554d659a3b26ea0b625e12c3ff0f63d09`. Final implementation commit at verification: `57e6f31f281e09cb1a209afe1264c05aeca9a56a`.

## Implemented outcome

Torchiko now owns durable company operational context and institutional memory in its existing PostgreSQL/Prisma system. It provides compact organization context, bounded timelines/correspondence/meetings, categorized relationship knowledge, milestones, open loops, commitments, cached relationship summaries, current decisions and priorities, provenance, revisions, promotion, deduplication, supersession, and permission-aware hybrid retrieval.

Packet A infrastructure remains canonical: agent identities/runs/leases/questions/outcomes, credential scoping, event/audit evidence, provider/model routing, budgets, embeddings, Gmail correspondence, queues, tenant middleware, developer tooling, and Golden Venue conventions were extended rather than replaced.

Machine actions use verified human, agent, system, or integration actors. Audit evidence can identify the credential, agent identity, run, worker, capability, model/provider metadata, approval grant, idempotency key, and bounded rationale without storing hidden reasoning. Approval grants are exact, expiring/revocable, one-shot or bounded authority. The first live approval-bound machine write creates an operational-update draft through the canonical domain action; outreach sending, billing effects, publication, credential issuance, deployment, offboarding, and destructive actions remain restricted.

The authenticated standards MCP JSON-RPC route supports initialization, tool discovery, schemas, metadata, calls, and structured errors. Portable workers can register, heartbeat, go offline, claim compatible durable runs, lose leases, and be replaced without losing company state. Agent roles, workers, models/providers, and runs remain separate identities.

Meeting sources can be ingested with external artifact references, queued through the existing durable AgentRun boundary, processed by an authorized worker, and completed with bounded extraction candidates and provenance. Candidates are not silently promoted. Completion invalidates the affected account summary for later refresh. Correspondence observations use the existing synchronized messages and can propose concise source-linked candidates without copying whole email bodies.

Admin users receive a Company Brain registry for current/candidate/superseded knowledge, decisions, priorities, provenance, and meeting processing. CRM account pages expose relationship context, contacts, venues, activity, meetings, support, open loops, and knowledge. AI Operations exposes real worker heartbeat/lease state and unified secret-free integration health.

## Agent-facing contracts

- `torchiko.account.get_context`
- `torchiko.account.timeline`
- `torchiko.account.meetings`
- `torchiko.account.meeting_get`
- `torchiko.account.correspondence`
- `torchiko.meeting.process`
- `torchiko.knowledge.search`
- `torchiko.knowledge.get`
- `torchiko.integrations.health`

All are bounded, credential/capability scoped, tenant-safe, schema-versioned, provenance-aware, and return detail-navigation hints rather than unbounded database records. Semantic ranking operates only over IDs selected by relational permission and authority filters.

## Proof

- A fresh disposable `pgvector/pgvector:pg16` database applied all 141 migrations from zero.
- The database-backed friend-takeover shakedown passed: secondary admin and independent worker registration, MCP discovery, unfamiliar mature-account context, selective deep knowledge, current-over-superseded decision retrieval, machine-attributed write, exact grant consumption/non-reuse, durable question, meeting processing, lease expiry, replacement-worker recovery, idempotency, Tom-worker return, Obsidian absence, and primary-PC absence.
- Scale proof used 1,200 milestones, 600 relationship notes, 300 open loops, and 2,000 knowledge items. Compact context was 8,753 bytes in 33.18 ms; knowledge search was 2,455 bytes in 23.47 ms. Reviewed PostgreSQL plans used `account_milestones_timeline_idx` (0.094 ms) and `company_knowledge_organization_idx` (1.066 ms).
- The bound-array pgvector candidate query executed successfully against the disposable database.
- `pnpm test` passed all package suites and 184 script/architecture tests; one unrelated legacy integration test remained intentionally skipped.
- `pnpm typecheck`, `pnpm lint`, production builds, and the browser-deliverable secret scan passed.
- AI provider/budget, raw SQL (97 reviewed operations), tenant bypass/procedure/registry (192 classified models and 103 generated cross-tenant procedures), public surface, agent tool coverage, and scenario coverage gates passed.
- `pnpm torchiko company-brain status --json` and `pnpm torchiko doctor --json` reported healthy; all consequential execution/provider gates were default-off in the verified environment.

## Shakedown repairs

The repair loop corrected the live credential-capability database trigger rather than adding a parallel check, invalidated cached account summaries after meaningful meeting completion, refreshed the central AI-workload registry test, inventoried the authenticated MCP route, removed runtime `Prisma.join` from Company Brain search, registered exact pgvector SQL signatures, taught the shared SQL verifier to distinguish safe type-only Prisma namespaces from prohibited runtime fragment helpers, split worker health out of an oversized admin router, and froze staging predeploy to the reviewed 141-migration/193-table chain.

## External state and limitations

No production or shared staging migration was run, no deployment was performed, no credential was accessed, and no outbound communication was sent. Google Workspace/Meet acquisition is internally pipeline-ready but requires an owner-authorized OAuth client/scopes and source-retention decision before live ingestion. The provider-backed retrieval evaluator is implemented through the central economy-tier routing, admission, budget, usage, and fencing systems, but no paid live evaluation was dispatched without explicit provider credentials/spend authorization. Provider-free grounding evaluation is green.

The compact summaries are deterministically refreshable and become stale after meaningful meeting changes; deployment must enable the existing runner and schedule appropriate refresh jobs for continuous production operation. External MCP/worker ingress also remains default-dark until an operator enables the existing bridge rollout gate and issues scoped credentials.

## Acceptance answer

For the implemented and tested scenarios, yes: Torchiko is sufficiently self-contained for an authorized AI workforce to understand an unfamiliar customer, retrieve deeper institutional context only when needed, act through bounded canonical operations, survive worker loss, and hand work to another compatible runtime without Tom's Obsidian vault or primary Hermes machine. External compute and integrations add capacity and source acquisition; they are not the database of record.
