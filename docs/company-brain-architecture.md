# Torchiko Company Brain architecture

Status: implemented foundation and integrated disposable shakedown, 2026-08-21.

Torchiko owns the company state required to operate Torchiko. Obsidian/Tom OS is an optional personal-knowledge bridge, object storage holds large source artifacts, and agent runtimes are replaceable workers. Neither Obsidian nor a worker's private memory is an operational database.

## Authority and storage

1. **Operational truth** remains in the existing tenant-safe PostgreSQL/Prisma domain models: organizations, venues, billing, support, correspondence, jobs, approvals, integrations, and audit evidence.
2. **Company Knowledge** stores governed institutional memory: decisions, priorities, rationale, meeting-derived context, lessons, and account insights. It never replaces operational tables.
3. **Artifacts** remain external when large. `CompanyMeeting.sourceArtifactRef` and knowledge provenance retain bounded references; ordinary reads use extracted summaries.
4. **Obsidian** may receive or originate review candidates, but promoted Torchiko knowledge is stored in Torchiko. No runtime query depends on the vault.
5. **Ephemeral agent context** is disposable. Important outcomes must be written through canonical Torchiko actions.

Company Knowledge records carry access scope, authority, promotion state, revisions, source provenance, entity links, optional semantic indexing metadata, and supersession. Platform strategy is not returned to client-scoped credentials. Permission filters are applied before semantic candidate selection.

## Retrieval hierarchy

| Level | Interface                                | Purpose                                                                                                                                                              |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0     | `torchiko.account.get_context`           | Compact identity, contacts, commercial/venue state, current summary, recent activity, milestones, open loops, commitments, warnings, and provenance. Target: 16 KiB. |
| 1     | timeline, meetings, correspondence tools | Bounded recent operational history with cursors.                                                                                                                     |
| 2     | exact meeting/knowledge detail           | One source record or extracted artifact reference.                                                                                                                   |
| 3     | `torchiko.knowledge.search`              | Permission-first structured/lexical or hybrid semantic institutional-memory search. Target: 12 KiB.                                                                  |
| 4     | original artifact reference              | Full transcript or document only when explicitly needed.                                                                                                             |

Search combines exact scope/type/authority/date filters with lexical relevance, optional embeddings, recency, and current authority. `knowledge.search` returns snippets and provenance; `knowledge.get` returns one exact governed item. Superseded items are excluded by default but remain queryable for historical work.

## CRM continuity

`ProspectOrganization` remains the canonical organizational identity. `ProspectCustomerRelationship` links the same prospect relationship to a customer tenant without erasing prospect history. Contacts, outreach, meetings, milestones, opportunities, support, venues, relationship notes, open loops, commitments, and summaries all link back to the organization.

Deterministic facts remain derived from canonical records. Durable relationship notes have taxonomy, provenance, confidence, authority, promotion, and supersession. `AccountSummary` is a versioned, refreshable projection with a source-input digest; it does not overwrite facts. The CRM account page exposes the compact summary, provenance, meetings, loops, commitments, relationship notes, and relevant Company Knowledge.

## Meetings and correspondence

Meeting ingestion, extraction, and completion are canonical idempotent actions. A meeting records participants, organization/venue/opportunity links, provider identity, artifact reference, lifecycle status, processing provenance, and categorized candidate extractions. Candidate outputs do not become authoritative automatically.

An authorized live worker with `meetings:process` can call `torchiko.meeting.process` from its leased run. The tool validates worker, credential, run, tenant, venue, and meeting scope; records at most 25 idempotent candidate extractions; and completes processing. Partial retries replay existing candidates. Promotion remains a separate governed decision.

Platform admins queue processing through the existing durable `AgentRun` and enqueue boundary. The task survives worker loss, remains default-dark when the runner is disabled, and can be claimed by another compatible worker after lease expiry.

Correspondence reuses the existing Gmail/thread synchronization. Significant messages may create bounded low-risk knowledge candidates; trivial messages do not become permanent memory. External Google Workspace/Meet source acquisition still requires owner OAuth scopes, but the internal ingestion/extraction pipeline and synthetic fixture path do not.

## Actors, approvals, and writes

Audited actions accept a verified actor abstraction: human, agent, system job, or external integration. Machine evidence includes credential, identity, run, worker, capability, approval grant, model/provider when supplied, and idempotency key. Agents are never recorded as human users.

Approval grants are durable and bounded by action, exact resource/parameters, agent, expiration, and use mode. One-shot grants are transactionally consumed by the canonical write. Exact retries replay the committed result; a different operation cannot reuse the grant.

An answered agent question remains run context by default. A platform administrator may separately and explicitly classify an answer as account context, durable preference, reusable policy, or strategic decision. Promotion is idempotent, links back to the exact question/run, uses the normal knowledge action, and requires organization scope for account-specific claims plus rationale for policies and decisions.

The first enabled machine write is the operational-update draft. It is internal and reviewable, requires `updates:draft`, a verified exact grant, an active run/worker/credential, and writes normal audit/event evidence. Outbound sales, publication, billing effects, credential issuance, deployment, and destructive actions remain human-controlled.

## Worker portability and MCP

Agent identity (role), worker/runtime (compute), model/provider (execution), and run/job (durable work) are separate records. Workers register protocol version, runtime type, capability/role support, safe software/model metadata, and heartbeat. Missing heartbeats mark compute unavailable without losing jobs. Expired run leases may be reclaimed by another compatible worker.

The authenticated `/api/mcp/[tenantId]/[venueId]` route implements bounded MCP JSON-RPC initialization, tool discovery, and tool calls over the Packet A registry. Credentials remain revocable and capability-scoped. Tool metadata declares schema, effect class, approval requirement, idempotency, limits, and capability. Database trigger validation and TypeScript capability contracts are kept in parity.

## Privacy, retention, and isolation

- New records are classified as platform, tenant, organization, venue, or restricted scope.
- Client search cannot see platform strategy or another tenant's knowledge.
- Visitor conversation projections remain privacy-bounded; Company Brain does not ingest raw visitor histories by default.
- Raw prompts, secrets, chain-of-thought, transcript bodies, and credential material are excluded from routine context and audit.
- Existing retention and artifact policies remain controlling.

## Developer and proof commands

```powershell
pnpm torchiko doctor --json
pnpm torchiko tools list --json
pnpm torchiko company-brain status --json
pnpm torchiko company-brain scenarios --json
```

The five registered provider-free scenarios are new prospect, converted small museum, mature multi-venue customer, difficult relationship, and friend takeover. The executable disposable tests are:

- `company-brain-shakedown.disposable.integration.test.ts` — worker takeover, MCP, context escalation, approval consumption, machine write, audit, failover, and Obsidian-loss proof.
- `company-brain-scale.disposable.integration.test.ts` — bounded projections at realistic account/knowledge volume.
- `company-brain-retrieval.test.ts` — deterministic grounding/currentness/retrieval-economy scoring.

Provider-backed retrieval replay is deliberately explicit. `runProviderBackedCompanyBrainRetrievalEvaluation` uses the central `company-brain-retrieval-evaluation` workload, economy-only routing, admission guard, budget gate, and usage sink. It is not dispatched by normal tests.

## Measured local disposable result

On the 2026-08-21 disposable pgvector world, a mature synthetic account with 1,200 milestones, 600 relationship notes, 300 open loops, and 2,000 knowledge items produced an 8,753-byte compact context in 33.18 ms and a 2,455-byte five-result search in 23.47 ms. PostgreSQL `EXPLAIN (ANALYZE, BUFFERS)` used `account_milestones_timeline_idx` (0.094 ms) and `company_knowledge_organization_idx` (1.066 ms). These are local measurements, not production latency promises.

## External setup boundary

Google Workspace/Meet acquisition requires the owner to configure the legitimate OAuth application/scopes and enable the integration. Production worker/MCP availability likewise requires deployment configuration and issued credentials. Those external steps do not affect the self-contained database model, provider-free tests, or portability proof.
