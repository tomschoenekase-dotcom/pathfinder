# Torchiko State of System

| Snapshot field              | Value                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audit completed             | 2026-08-19, America/Chicago                                                                                                                                                                  |
| Repository                  | `C:\Users\tomsc\Downloads\PathFinder`                                                                                                                                                        |
| Branch                      | `codex/torchiko-cloud-staging-20260819`                                                                                                                                                      |
| HEAD                        | `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b` (`feat: prepare Torchiko cloud staging release`)                                                                                                  |
| Audited state               | The current working tree, including substantial uncommitted launch-capability work; not HEAD alone                                                                                           |
| Environment observed        | Local staging: web `:3100`, dashboard `:3101`, PostgreSQL/pgvector, Redis, MinIO and ClamAV healthy; worker in `provider-disabled-health-only` mode                                          |
| Previous canonical snapshot | None found in `docs/system-state`                                                                                                                                                            |
| Confidence                  | High for code-supported behavior and local non-provider flows; medium/unknown for live cloud operation, current production data, provider-backed AI, email delivery, and real customer usage |

## How to read this report

The source code, schema, tests, executable configuration, local staging runtime, and inspected UI are the evidence base. Plans and older implementation packets were used only as leads. Statuses mean:

- **PRODUCTION-READY** — implemented, integrated, reasonably tested, and usable; this does not imply that a production deployment was observed.
- **IMPLEMENTED BUT NEEDS POLISH** — functional, but UX, reliability, verification, or integration needs work.
- **PARTIALLY IMPLEMENTED** — meaningful implementation exists, but a major part of the promised workflow is absent.
- **SCAFFOLDED** — schema, contract, route, or component exists without much usable end-to-end behavior.
- **DOCUMENTED ONLY** — described but not meaningfully implemented.
- **LEGACY / SUPERSEDED** — retained compatibility path, not the preferred architecture.
- **BROKEN** — intended flow fails in the inspected state.
- **UNKNOWN** — the repository and safe local checks cannot establish the claim.

## Executive Summary

Torchiko is a substantial multi-tenant venue intelligence platform, not a prototype landing page. PathFinder is its implemented venue application: a public conversational guide, a deliberately simple client portal, a deep internal operating system, a content/intake/release pipeline, analytics and reports, and a durable background-job layer. “Torchiko” is increasingly the customer-facing umbrella; “PathFinder OS” remains the internal application and repository vocabulary. Hermes is not a separate in-repository platform today. It appears as one optional external agent-bridge provider alongside Codex, Claude, and OpenAI-compatible local runners.

The strongest engineering is below the visible product. Tenant-scoped procedures, database guardrails, explicit bypass registries, idempotent chat turns, leases, retries, immutable evidence, AI budget reservations, public-surface manifests, quarantine-aware uploads, and a unusually comprehensive test suite show serious operational thinking. The public chat, remote onboarding, client portal, and admin workspaces are visually deliberate and have good empty/error states. Content packages, native releases, evaluation runs, agent runs, support cases, and audit records have real persistence and lifecycle code rather than only UI mocks.

The main maturity gap is operational proof. The local venue inspected had no content, packages, reports, or completed onboarding, and provider-backed workers were deliberately disabled. Consequently this audit could not prove a real prospect-to-live-venue cycle, a successful grounded AI answer, a voice session, an autonomous/specialist agent run, a delivered report, or cloud recovery. The code can support many of these flows, but code-supported is not the same as production-proven.

The largest product gaps in the audited baseline were equally concrete. CRM, sales pipeline, outreach sequences, inbound email, general outbound communications, billing collection, and meeting scheduling did not exist at that snapshot; later branch deltas in this report must be consulted before treating those statements as current truth. The client portal intentionally hides most analytics and content-management power, so internal operators carry much of the workload. Since the audit, bounded citation projection now exposes safe provenance for explicitly named retrieved records and persists it across replay, while claim-level semantic support remains unproven. Location V1 resolves known location context, and platform administrators can now create, correct, review, activate, and deactivate exact-venue anchors through a mobile-responsive workspace. It still does not provide turn-by-turn routing. Outcome observations can now be assembled into immutable, versioned improvement hypotheses with human review through admin and MCP surfaces; approval deliberately applies nothing and changes no authority. Automatic prompt/routing/model/policy learning remains absent. The event center is a strong in-app aggregation surface, while its multi-channel delivery model is largely scaffolded.

The highest immediate value is not another broad architecture layer. It is to run and preserve one golden, real-data lifecycle: create a client and venue, complete remote intake, verify extraction/review, approve and publish a package, answer grounded guest questions, collect feedback, generate a report, handle a support case, and safely offboard/export. That exercise should validate the now-coded guest failure taxonomy and continue driving the missing privacy page, notification delivery, client visibility, recovery posture, and observability. Only after this flow is repeatable should Torchiko expand into a CRM or autonomous outreach system.

### Health assessment

**Overall: healthy engineering foundation, credible private-beta product, not yet operationally proven as a self-serve or high-scale SaaS.** There was no test, typecheck, lint, build, static-boundary, local health, accessibility, or browser-foundation failure. Risks concentrate in incomplete commercial workflows, application-layer-only tenancy, unproven provider/cloud execution, missing retention automation, and the cost/complexity of parallel legacy and native content models.

### Biggest bottlenecks

| Kind        | Bottleneck                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational | No retained evidence of a complete real-customer lifecycle in the current environment; the demo tenant is mostly empty.                           |
| Technical   | Two content/deployment generations coexist, and 193 approved tenant-isolation bypass calls plus 94 raw-SQL operations increase review burden.     |
| Product     | Clients cannot independently manage much content or see useful analytics, while CRM, billing, and broad communications are absent.                |
| UX          | Provider-disabled chat is reported as an ambiguous delivery outcome; the marketing privacy link has no matching route.                            |
| Scale       | Human review, onboarding, package approval, support, and exception handling still concentrate in a sophisticated but operator-heavy admin system. |

## Changes Since Previous Audit

No earlier `docs/system-state/TORCHIKO_STATE_OF_SYSTEM.md` existed, so this is the baseline. Relative to older architecture and packet documents, the current working tree materially adds product entitlements, provider-neutral capability routing, realtime voice foundations, conversation insights, operational events, knowledge-change proposals, Location V1, message feedback, broader agent-question types, and multimodal/voice usage rollups. These additions are uncommitted at audit time and must not be described as deployed.

Architecturally, the repository has moved from a venue CRUD/chat application toward immutable content revisions and manifests, native releases, durable job dispatch, evaluations, persistent agents, and a unified operations attention console. The older `Place`/`VenueKnowledgeEntry` and `VenuePackage` paths remain active compatibility systems. No regression was found by the automated suite, but the working tree is a large integration surface (61 tracked files changed plus many untracked files and migrations), so a clean review/commit boundary is still needed.

## System Map

```mermaid
flowchart LR
  Visitor["Venue visitor"] --> Web["Public Next.js web\nstandalone, embed, chat"]
  Client["Venue client"] --> Dash["Next.js dashboard\nclient portal"]
  Operator["Torchiko operator"] --> Dash
  AgentRunner["External agent bridge\nCodex / Claude / Hermes / local"] --> Bridge["Machine-credential bridge API"]
  Web --> API["tRPC/API service layer"]
  Dash --> API
  Bridge --> API
  API --> DB["PostgreSQL + pgvector\nPrisma"]
  API --> Redis["BullMQ / Redis"]
  API --> Storage["S3-compatible object storage"]
  Redis --> Workers["Worker process\n15 processor modules"]
  Workers --> DB
  Workers --> Storage
  API --> AI["AI gateway\nAnthropic text, OpenAI embeddings/realtime"]
  Workers --> AI
  Workers --> Email["Resend\nwelcome email only"]
  Web --> Sentry["Sentry / structured logs"]
  Dash --> Sentry
  Workers --> Sentry
```

### Repository shape

- `apps/web`: public marketing, venue shell, guest chat, embed/widget, health route.
- `apps/dashboard`: Clerk-authenticated client portal and platform-admin operating system.
- `apps/workers`: BullMQ workers, schedulers, leases, recovery, media, agents, reports, evaluations, embeddings, and analytics.
- `packages/api`: tRPC routers, HTTP-facing logic, admin router modules, MCP/agent-bridge actions, context building, and authorization.
- `packages/db`: 124-model Prisma schema, 122 migrations, tenant middleware, auditable domain actions, raw SQL, lifecycle helpers.
- `packages/ai`: model/embedding registries, centralized gateway, budgets, workload configuration, capability routing, realtime voice.
- `packages/contracts`: Zod contracts for guest responses, content, packages, evaluations, entitlements, characters, and operations.
- `packages/jobs`, `analytics`, `auth`, `config`, `intake-engine`, `ui`: shared infrastructure and domain packages.

The repo contains 13 workspaces, 757 production source files, 565 test files, 73 dashboard pages, 6 public-web pages, 92 API-router source files, and 15 worker processor modules. These counts describe breadth, not maturity.

### Public surfaces

The canonical allowlist is `packages/api/src/testing/public-surface-manifest.json`: 15 public tRPC procedures, seven HTTP route modules, and two dashboard public API path groups. Public tRPC covers health, venue lookup, chat, analytics collection, feedback, location resolution, widget availability, and voice lifecycle. Clerk webhook, agent bridge, web/dashboard tRPC, health, and widget readiness are the significant HTTP surfaces.

## Product Surface Inventory

| Area      | Feature                                     | Status                       | Evidence / Location                                                                                                                                                               | Quality                                        | Important Notes                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visitor   | Venue chat and session persistence          | IMPLEMENTED BUT NEEDS POLISH | `packages/api/src/routers/chat.ts`; `packages/db/src/helpers/guest-chat-turn-actions.ts`; `apps/web/components/VenueChatExperience.tsx`                                           | Strong reliability design                      | Durable reservation/claim/finalization and retry IDs; local provider-disabled failure was understandable only at a technical level.                                                                                                                                                           |
| Visitor   | Grounded semantic retrieval                 | PRODUCTION-READY             | `packages/db/src/helpers/semantic-search.ts`; `packages/api/src/lib/venue-context.ts`                                                                                             | Strong                                         | pgvector ranking is venue/tenant/visibility scoped; live answer quality was not provider-tested.                                                                                                                                                                                              |
| Visitor   | Structured responses/actions                | IMPLEMENTED BUT NEEDS POLISH | `packages/contracts/src/guest-response.ts`; `apps/web/components/ResponseRenderer.tsx`                                                                                            | Broad contract, good renderer                  | Contract is ahead of what the chat generator consistently produces.                                                                                                                                                                                                                           |
| Visitor   | Citations                                   | PARTIALLY IMPLEMENTED        | citation contract/renderer; deterministic guest citation projection; idempotent replay metadata                                                                                   | Conservative retrieved-record proof            | Explicitly named retrieved records can expose safe provenance; claim-level semantic support and provider-enabled staging QA remain.                                                                                                                                                           |
| Visitor   | Multilingual chat                           | IMPLEMENTED BUT NEEDS POLISH | `apps/web/components/LanguagePicker.tsx`; language-aware chat request/context                                                                                                     | Good UI                                        | Ten languages are selectable; translation is model behavior, not a translation pipeline; no live quality verification.                                                                                                                                                                        |
| Visitor   | Realtime voice                              | PARTIALLY IMPLEMENTED        | `packages/api/src/routers/voice.ts`; `packages/ai/src/realtime-voice.ts`; `apps/web/components/VoiceControl.tsx`                                                                  | Serious foundation                             | WebRTC ephemeral auth, quota, transcripts, usage exist; feature/entitlement/provider gated and unverified live.                                                                                                                                                                               |
| Visitor   | Location awareness                          | IMPLEMENTED BUT NEEDS POLISH | guest anchor/catalog/route resolvers; responsive route planner; guarded admin floor/anchor/connection workspace; `torchiko.locations.propose_draft`; location intelligence schema | Safe resolver and progressive review lifecycle | Visitors can select reviewed destinations and receive bounded shortest-path guidance with strict accessibility filtering. Weighted routing, real-venue/device QA, and live turn-by-turn navigation remain.                                                                                    |
| Visitor   | Feedback                                    | IMPLEMENTED BUT NEEDS POLISH | `packages/api/src/routers/feedback.ts`; `MessageFeedback` migration/UI                                                                                                            | Useful foundation                              | Persistence and controls exist in current uncommitted work; operator closed loop remains thin.                                                                                                                                                                                                |
| Visitor   | Branding/Tochi                              | IMPLEMENTED BUT NEEDS POLISH | venue bot/design modules; character system; `apps/web/components/VenueChatShell.tsx`                                                                                              | Polished                                       | Only `tochi-dev-v0` is currently verified and it is non-publishable development art.                                                                                                                                                                                                          |
| Client    | Simple portal, single/multi-venue           | PRODUCTION-READY             | `apps/dashboard/components/DashboardOverview.tsx`; `(app)` routes; portal router                                                                                                  | Deliberately simple and polished               | Venue selection and status are clear; current demo data is empty.                                                                                                                                                                                                                             |
| Client    | Remote onboarding/uploads                   | IMPLEMENTED BUT NEEDS POLISH | `RemoteOnboardingJourney.tsx`; `IntakeFileUpload.tsx`; portal onboarding/intake routers                                                                                           | Excellent safeguards                           | Website, notes and resumable files; client cannot publish; real extraction-to-release lifecycle unproven.                                                                                                                                                                                     |
| Client    | Analytics/chat logs/content editing         | PARTIALLY IMPLEMENTED        | privacy-bounded visitor pulse; service-led correction request; legacy authoring routes redirect; admin surfaces hold full tools                                                   | Safe and intentionally narrow                  | Clients see aggregate activity/quality signals and can request a correction, but cannot inspect raw conversations or direct-publish.                                                                                                                                                          |
| Client    | Weekly reports                              | IMPLEMENTED BUT NEEDS POLISH | weekly report routes/components; worker processor and DB lifecycle                                                                                                                | Strong lifecycle                               | Clients only see published reports; no delivered current report was available.                                                                                                                                                                                                                |
| Client    | Support                                     | PRODUCTION-READY             | `packages/api/src/routers/support.ts`; `SupportWorkspace.tsx`; admin support operations                                                                                           | Strong                                         | Good state handling and internal handoff model. Email-channel support is absent.                                                                                                                                                                                                              |
| Client    | Roles/account                               | IMPLEMENTED BUT NEEDS POLISH | Clerk auth/org sync; tenant/membership models; settings                                                                                                                           | Adequate                                       | Owner/admin/member exist; sophisticated entitlement/billing administration is internal.                                                                                                                                                                                                       |
| Client    | Billing/payments                            | SCAFFOLDED                   | plan/entitlement/billing visibility fields and UI; no payment provider                                                                                                            | Not sell-and-collect ready                     | No Stripe, checkout, invoices, dunning, or subscription reconciliation.                                                                                                                                                                                                                       |
| Admin     | Client/venue command center                 | PRODUCTION-READY             | `apps/dashboard/app/(admin)/admin`; admin shell/directory/operations                                                                                                              | Visually and functionally strong               | Clear hierarchy; deep breadth still imposes operator learning cost.                                                                                                                                                                                                                           |
| Admin     | Content/intake/package/release controls     | IMPLEMENTED BUT NEEDS POLISH | admin routers/components; manifest and native-release helpers                                                                                                                     | Deep safety model                              | End-to-end real venue proof is the missing piece.                                                                                                                                                                                                                                             |
| Admin     | AI controls, costs, evaluations             | IMPLEMENTED BUT NEEDS POLISH | AI config, cost/budget forms, evaluation operations                                                                                                                               | Strong internals                               | Local provider execution disabled; live routing/fallback not verified.                                                                                                                                                                                                                        |
| Admin     | Operations attention console                | IMPLEMENTED BUT NEEDS POLISH | `attention-console.ts`; `OperationsAttentionConsole.tsx`                                                                                                                          | Coherent command-center direction              | Aggregates jobs, evals, support, agents, questions, approvals, outcomes and events.                                                                                                                                                                                                           |
| Admin     | CRM/sales/outreach                          | DOCUMENTED ONLY              | no prospect/contact/pipeline/sequence domain implementation                                                                                                                       | Absent                                         | An “outreach steward” agent identity is not a CRM or sending workflow.                                                                                                                                                                                                                        |
| Email     | Welcome email                               | IMPLEMENTED BUT NEEDS POLISH | `send-welcome-email.ts`; Clerk webhook/job tests                                                                                                                                  | Narrow and reliable                            | Only automated send found; still uses PathFinder branding/link.                                                                                                                                                                                                                               |
| Email     | General inbound/outbound/approval           | DOCUMENTED ONLY              | no provider-backed communications domain                                                                                                                                          | Absent                                         | AI cannot autonomously email clients, prospects, or guests.                                                                                                                                                                                                                                   |
| Agents    | Durable identities/runs/questions/approvals | IMPLEMENTED BUT NEEDS POLISH | agent Prisma models; admin agent routers/UI; `agent-run.ts`                                                                                                                       | Strong state machine                           | Real direct Anthropic execution exists; local live run not verified.                                                                                                                                                                                                                          |
| Agents    | Specialist delegation/tool use              | PARTIALLY IMPLEMENTED        | MCP registry/read actions; bridge runner; delegation records                                                                                                                      | Conditional                                    | Direct worker is text-only; actual tools/delegation require an external bridge.                                                                                                                                                                                                               |
| Agents    | Learning from outcomes                      | SCAFFOLDED                   | `AgentOutcomeObservation` writes/reads/UI                                                                                                                                         | Persistence only                               | No consumer changes prompts, routing, reputation, policies, or model selection.                                                                                                                                                                                                               |
| Events    | Operational event center                    | IMPLEMENTED BUT NEEDS POLISH | operational-event helper/model; attention console; four producers                                                                                                                 | Good in-app core                               | Severity/state/dedupe/audit work; delivery channels are not operational.                                                                                                                                                                                                                      |
| Events    | Email/SMS/push/Slack/webhook delivery       | SCAFFOLDED                   | `OperationalEventDelivery` schema/enums                                                                                                                                           | Schema only                                    | No dispatcher/provider integration found.                                                                                                                                                                                                                                                     |
| Quality   | Evaluation lifecycle/regressions            | IMPLEMENTED BUT NEEDS POLISH | evaluation contracts/models/worker/admin UI                                                                                                                                       | Unusually strong                               | Frozen snapshots, thresholds, budgets and human review; no current production dataset/run history observed.                                                                                                                                                                                   |
| Knowledge | Legacy Place/knowledge                      | LEGACY / SUPERSEDED          | `place.ts`, `knowledge.ts`, `legacy-content-actions.ts`                                                                                                                           | Still functional                               | Semantic retrieval still depends on it; exact convergence and frozen legacy-to-native shadow comparisons are measurable, and the retained compatibility path is the explicit rollback target. No read switch or retirement is authorized.                                                     |
| Knowledge | Native module/revision/publication model    | IMPLEMENTED BUT NEEDS POLISH | content models/actions, manifests, native deployments, convergence, shadow-comparison measurement, non-executable read-switch contract                                            | Strong but complex                             | Exact head drift and same-corpus legacy/native deltas feed an explicit fail-closed contract. A nonzero disposable apply/revert now proves exact compatibility restoration; representative evidence, approved thresholds, a real read executor/rehearsal, and production approval remain open. |
| Intake    | Multimodal media ingestion                  | IMPLEMENTED BUT NEEDS POLISH | `media-ingestion.ts`; storage/ClamAV/FFmpeg/OpenAI plumbing                                                                                                                       | Guarded and tested                             | Image/audio/video/ZIP/doc flows exist; no dedicated OCR engine found and live providers were disabled.                                                                                                                                                                                        |
| Reporting | Events, rollups, insights, reports          | IMPLEMENTED BUT NEEDS POLISH | analytics package/router; daily/weekly/analysis workers                                                                                                                           | Broad                                          | AI-generated summaries and conditional report sections exist; production correctness/usage not proven.                                                                                                                                                                                        |
| Security  | Auth and application tenant isolation       | PRODUCTION-READY             | Clerk context; `trpc.ts`; tenant middleware; verification scripts                                                                                                                 | Strong application controls                    | No database row-level security; bypass/raw-SQL surface needs disciplined review.                                                                                                                                                                                                              |
| Privacy   | Retention/deletion                          | PARTIALLY IMPLEMENTED        | retention inventory/readiness contract; offboarding/export                                                                                                                        | Explicitly incomplete                          | All policy decisions must be set; no general retention/deletion executor found.                                                                                                                                                                                                               |
| Infra     | Local staging                               | PRODUCTION-READY             | compose/local-staging scripts and live health                                                                                                                                     | Good developer surface                         | Postgres, Redis, MinIO, ClamAV healthy during audit.                                                                                                                                                                                                                                          |
| Infra     | Railway staging/production                  | PARTIALLY IMPLEMENTED        | three Railway service configs, Dockerfiles, staging verifier                                                                                                                      | Code-supported                                 | Actual deployed services, secrets, migrations, domains, and alerting were not inspected.                                                                                                                                                                                                      |
| Infra     | Backup/recovery                             | IMPLEMENTED BUT NEEDS POLISH | backup script/tests; prior restore evidence docs                                                                                                                                  | Manual safety path                             | Prior archive/restore evidence exists, but Supabase Free plan had no scheduled backups/PITR; current provider state unknown.                                                                                                                                                                  |

## User Journey Status

### Visitor

A visitor can open a branded venue route or embed, receive suggested questions, choose a language, persist an anonymous scoped session, and send retry-safe chat turns. The API validates venue/experience visibility, rate limits, retrieves public venue knowledge, records analytics, and produces structured responses. Privacy and “verify important details” messaging are visible. Guest failures now use browser-safe codes for provider unavailable, rate limited, outcome ambiguous, content unavailable, rejected, and transient pre-dispatch failure. Known failures receive definite recovery guidance; only genuinely unclassified transport outcomes retain exact idempotent retry or history reconciliation. Provider route exhaustion commits a safe fallback and emits a deduplicated operational event. Deterministic citations expose safe provenance for explicitly named retrieved records and persist across exact replay/reload; this is not claim-level semantic attribution. Realtime voice and the failure taxonomy still need provider-enabled staging proof, and turn-by-turn routing does not exist.

### Venue client

A Clerk-authenticated client sees a clean “today” portal, can switch among venues, inspect status, upload onboarding sources, add website/staff context, view published weekly reports, request support, and manage basic account data. The product intentionally routes old analytics and authoring screens away from clients. This makes the portal safe and understandable, but it also means customers depend on Torchiko operators for content correction, publishing, deep analytics, model settings, packages, and most lifecycle actions.

### Torchiko operator/admin

A platform admin has the most complete journey: command center, client directory, venue workspace, onboarding intake, media, content revisions, compatibility content, packages, native releases, reports, chat logs, evaluations, agents, support, credentials, offboarding, costs, and AI incident controls. Dangerous operations tend to require explicit state transitions, typed reasons, or scoped identifiers. The journey is genuinely usable module by module, but the breadth and coexistence of old/new systems make it easy to operate the wrong abstraction without the handoff guide.

### AI agent

An operator can configure a disabled identity, enable it, compose a scoped task, persist a run, enqueue it, observe leases/retries/costs, answer structured questions, approve/reject actions, and record outcomes. A direct Anthropic worker executes text-only runs. Codex/Claude/Hermes/local providers require a separate bridge runner with machine credentials. Direct runs do not have tools and cannot perform autonomous changes. Outcome observations do not train or adapt the agent. Local staging had queued synthetic runs but provider execution disabled, so the full journey was not verified.

### Prospect → customer

This journey breaks before the product. Marketing offers a `mailto:` demo request. There is no prospect/company/contact model, pipeline, outreach sequence, lead score, meeting scheduler, quote, checkout, or billing provider. An operator can manually create a client/venue and trigger Clerk/welcome-email onboarding, after which the product journey begins.

### New venue onboarding

The client-side capture experience and internal intake/review/release systems exist. Upload policy includes per-file and per-venue limits, resumability, quarantine, malware scanning, verification states, evidence and proposal review, package manifests, evaluation evidence, and publish controls. The missing proof is a retained golden run using realistic mixed source material through to a live guest answer. Manual review and operator release remain intentional scaling gates.

### Venue content update

Updates can enter through client onboarding/support or admin content tools, become immutable module revisions/proposals, be reviewed, included in a package/manifest, evaluated, and released. Legacy Place/knowledge editing remains separately available. Native deployment evidence supports rollback/forward history, while a non-executable read-switch contract makes the retained compatibility rollback target and unresolved gates machine-readable. A disposable two-venue cohort proves nonzero materialization and exact canonical revert after correcting jsonb-normalized evidence comparison. The bridge remains complex, contains explicit materialization limits, and has no runtime switch executor.

### Client support request

Clients can open and reply to support cases; operators can triage, request information, assign state, and maintain manual-loop evidence. This is a credible in-app workflow. It has no email ingestion/delivery, no SLA automation, and no refund/payment integration.

### Human approval / AI escalation

Agent questions support yes/no, choice, multi-select, short/long text, approval/reject, date/time, and structured-object answers. Approval requests and decisions are durable and auditable. The attention console combines these with failed jobs, evaluations, support, agent runs, outcomes, and operational events. The in-app path is coherent; external notification and proactive escalation channels are not.

## AI / Agent Architecture

### Model execution

`packages/ai` centralizes text generation, embeddings, realtime voice, model pricing, budget admission/reservations, usage events, workload configuration, and provider-neutral route planning. Today Anthropic handles registered text workloads, OpenAI handles embeddings and realtime voice, and fallback routing can filter unhealthy/disabled providers and models. The current launch-capability work makes future optimization structurally possible because calls record workload, capability, provider, model, tokens, cost estimate, latency, and fallback use.

Model switching is easier for registered application workloads than for agents: change a validated workload configuration/registry entry rather than every caller. A notable mismatch remains in direct agent runs: the identity’s provider decides direct-vs-bridge execution, but the direct worker invokes the hard-coded `AI_MODEL_KEYS.AGENT_RUN`. The displayed/configured identity `modelName` is not itself the executed Anthropic model. That should be made explicit or corrected before advertising per-agent model selection.

### Persistent agents and tools

The database persists identities, runs, actions, timeline events, approval requests/decisions, questions, messages, and outcome observations. Runs have queue records, attempt limits, leases, heartbeat, cancellation, retry, budget, usage, and terminal states. The direct worker is intentionally safe and text-only. Richer MCP read tools, “ask operator,” and delegation exist for connected bridge runners; write authority is disabled/approval-oriented.

Hermes is therefore an adapter choice, not a separate owned subsystem in this repo. The repository does not contain the Hermes runtime, model, memory, or scheduler. It contains a bridge capable of launching a `hermes` command in a separately controlled runner.

### Do agents improve as they work?

**No, not in the strong autonomous sense.** Humans can append an `AgentOutcomeObservation`, and agents/operators can read it. An authorized quality worker or platform admin can prepare one versioned `AgentImprovementProposal` from exact same-scope observations. After human approval, they can append an immutable implementation reference plus a same-corpus before/after evaluation comparison; corpus and evidence drift remain fail-closed, while content/model/config differences must be declared. Approval and validation perform no application and change no authority. There is still no runtime that rewrites instructions, changes routing/models, selects specialists, updates memory, or promotes permissions automatically. This is a bounded reviewed improvement loop, not autonomous self-modification.

### Human-in-the-loop and operations inbox

The strongest direction is the unified admin attention console rather than separate AI widgets. `packages/api/src/routers/admin/attention-console.ts` reads failed jobs, evaluations, approvals, support cases, agent runs/questions/outcomes, and operational events into one prioritized view. Operational events are emitted by chat reliability, voice quota/usage, evaluation regression, and knowledge-proposal flows. Dedupe keys, severity, read/ack/resolved states, actor data, links, and audit trails are implemented. `OperationalEventDelivery` advertises in-app/email/SMS/push/Slack/webhook channels, but no dispatcher was found; only in-app consumption is real.

## Data Architecture

The Prisma schema contains 124 models: 113 tenanted, nine platform-scoped, and two shared, enforced by an executable registry. Core identity is `User` → `Tenant`/`Membership` → `Venue`. Public experiences attach visitor sessions, conversation sessions/messages/turns, feedback, voice sessions, and analytics events to the venue.

Knowledge has two generations:

1. **Legacy retrieval:** `Place` and `VenueKnowledgeEntry`, both carrying embeddings and visibility metadata. Guest semantic search currently reads these directly.
2. **Native generalized content:** stable module identities, immutable revisions, typed subtype records, evidence/provenance, proposals, publications, manifests, native releases, and deployment heads.

Intake runs and uploads create verified source evidence and reviewable proposals. Package/manifest records freeze desired state and evaluation evidence; native releases record actual deployment state. Compatibility materialization allows some native changes to flow through older package/venue fields, with explicit limits. This preserves safety and auditability but is the largest source of schema and conceptual drift.

Cross-cutting records include job/audit logs, AI usage and daily rollups, budgets/reservations, report schedules/runs, evaluations, support, credentials, agent operations, operational events, entitlements, retention/offboarding, and location anchors. Append-only and lifecycle-sensitive models are protected in database action helpers and Prisma middleware.

For a future place/city/territory graph, the structured content identities, provenance, location anchors, typed modules, and pgvector foundation help. Venue-first foreign keys, duplicated legacy place semantics, and tenant-coupled publication/retrieval obstruct straightforward cross-venue knowledge sharing. Do not generalize this yet; first converge the venue content read path.

## Infrastructure

Local staging is a well-supported Docker-based environment. During the audit, PostgreSQL/pgvector, Redis, MinIO, and ClamAV were healthy; the web health route returned HTTP 200 with database and queue `up`. The health endpoint does not check object storage, malware scanning, AI providers, email, worker liveness/freshness, scheduler activity, or migration parity.

Railway has separate dashboard, web, and worker configurations plus Dockerfiles and executable staging-config gates. The public web config uses `/api/health`; equivalent deployed dashboard/worker health behavior was not established. A root Railway/Nixpacks configuration coexists with newer service-specific Docker configs and should be declared legacy or removed. No live Railway environment, domains, secrets, metrics, or deployment revision was inspected.

Supabase provides the PostgreSQL target. A password-prompted logical backup script pins PostgreSQL/pgvector client versions, requires SSL, refuses overwrite, uses a consistent snapshot, verifies `pg_restore --list`, and emits a hash/manifest. Older retained documentation records a successful archive and local restore rehearsal. It also records that the Supabase Free plan had no scheduled backups or PITR at that time. Current provider backup settings and a recent restore drill remain unknown.

CI provisions disposable pgvector PostgreSQL, Redis, and MinIO and runs migration, integration, bundle-secret, accessibility, type, lint, test, and build gates. The workflow is strong on paper; the current remote CI status was not accessible. Local compose uses floating MinIO `latest` and ClamAV `stable` tags, reducing reproducibility.

## Security / Tenant Isolation

Clerk supplies user and organization identity. `publicProcedure`, authenticated/tenant procedures, and platform-admin procedures provide backend boundaries; non-admin users cannot access internal routes merely by knowing URLs. Platform impersonation/tenant override is accepted only for platform admins and is cookie-scoped. Public guest routes revalidate venue, experience, visibility, and anonymous-session scope rather than trusting the browser.

Tenant isolation is application-enforced through Prisma middleware, tenant-aware helpers, composite ownership checks, and executable source gates. The audit found 193 approved bypass calls in 65 production files and 94 raw-SQL operations (34 reads, 60 writes). Those are inventoried and tests passed, but each expands the review surface. PostgreSQL row-level security was not found, so a missed predicate remains a plausible cross-tenant risk. This is not evidence of a present leak; it is a defense-in-depth gap.

Other meaningful controls include signed Clerk webhooks, machine credentials stored as hashes with rotation/revocation, server-only secret bundle scans, safe URL/origin contracts, upload size/decompression limits, quarantine and ClamAV, explicit AI kill switches, rate limits, budget admission, immutable evidence, and auditable dangerous actions. Public/embed response headers restrict framing, referrers, capabilities, and MIME sniffing.

Privacy is not complete. Guest messages and identifiers are persisted, but policy-to-execution retention/deletion is not. The retention readiness function intentionally refuses readiness until all required decisions are recorded; no general erasure scheduler/executor was found. Offboarding export/revocation is stronger than deletion. The marketing footer links to `/privacy`, but the public app has no privacy page, making the link broken. Prompt construction tells the model to use bounded public context, but a dedicated prompt-injection sanitizer/evaluation suite was not found.

## Testing / Quality

### Commands executed in this audit

| Check                                                          | Result                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                    | Passed: 3,926 package tests plus 164 script tests; 147 package tests and one script test skipped by environment/gating  |
| `pnpm typecheck`                                               | Passed: 23/23 tasks                                                                                                     |
| `pnpm lint`                                                    | Passed with one warning: raw `<img>` in `apps/web/components/PlaceCard.tsx:70`                                          |
| `pnpm build`                                                   | Passed: 13/13 workspaces; Sentry/OpenTelemetry dynamic-require warnings and Windows standalone-link warnings            |
| `pnpm verify:client-bundles`                                   | Passed: 11 server-only canaries/credential patterns checked across 408 browser-deliverable files                        |
| `pnpm test:accessibility`                                      | Passed: seven focused axe contracts                                                                                     |
| `pnpm test:browser-foundation`                                 | Passed: 186 DOM/browser-foundation tests                                                                                |
| `pnpm test:visual-browser`                                     | Added after the audit snapshot: nine real-Chromium phone/tablet/desktop smokes for Guest routing, portal and onboarding |
| AI/tenant/raw-SQL/public/staging/docker/character static gates | All passed                                                                                                              |
| Local health                                                   | HTTP 200; DB and queue up                                                                                               |
| Browser inspection                                             | Marketing, client home, admin OS, venue workspace, onboarding, and guest chat inspected at 1280×720                     |

The default unit suite skips integrations needing disposable DB/Redis/storage/ClamAV in the current invocation; CI has explicit jobs for many of them. The suite is strongest at state transitions, authorization, tenant predicates, validation, idempotency, worker retry/lease logic, and rendered component contracts. It is weaker at true browser automation across authenticated journeys, provider-backed AI quality, voice WebRTC, deliverability, cloud deployments, restoration, high-volume concurrency, and real mixed-media extraction.

This audit did not mutate tests to obtain green results. The guest chat interaction did create one local staging conversation/turn. Production data was not touched.

## UI / UX Assessment

The visual system is one of Torchiko’s strengths. The marketing page, lightweight client portal, remote-onboarding journey, venue workspace, and admin command center share a considered palette, typography, card language, spacing, and hierarchy. Empty states explain what happens next; upload and publishing screens repeatedly state that client input does not silently publish. Internal navigation groups “build/manage” separately from “observe/improve,” which makes a very large surface more understandable.

The weakest visible areas are not generic styling problems:

- the public chat’s provider-disabled failure copy implies uncertain delivery instead of temporary service unavailability;
- the marketing privacy link is broken and demo acquisition is a personal `mailto:`;
- the client portal is so intentionally narrow that analytics/content ownership may feel absent;
- internal pages expose both legacy compatibility and native concepts, increasing decision load;
- brand vocabulary is mixed: Torchiko externally, PathFinder OS internally, PathFinder in the welcome email, Tochi as character/assistant;
- the original audit completed only desktop interactive inspection. A later deterministic Chromium gate now confirms three synthetic phone/tablet/desktop journeys, but real-device, authenticated, deployed and assistive-technology evidence remains absent.

Development fixture routes appear in production build manifests but their page/middleware guards return not-found or require auth outside development. This is acceptable, though route-level exclusion would reduce noise.

## Reporting, Cost, and Observability

Analytics records raw guest events, conversation behavior, answer analyses, clusters/themes, daily rollups, report configurations, weekly digests, and published weekly reports. Conditional report sections and lifecycle evidence are tested. Client access is published-only; internal operators have the complete view. Production data correctness, late-event handling under load, and current report delivery were not independently verified.

AI costs are the best-instrumented variable cost. Model registries and usage events capture tokens, model/provider, latency, feature/workload, fallback, voice/audio and estimated cost; budgets and reservations bound spend. Storage, database, hosting, Sentry, email, antivirus, bandwidth, and human-review costs are not unified into unit economics. Exact AI prices can drift, so estimates must not be treated as invoices.

An operator can inspect failed jobs, stuck agent/evaluation states, support work, AI incident mode, usage/cost, freshness, package/release status, and some low-confidence chat failures. The Founder Control Room now also shows authenticated service-readiness evidence for exact migrations, worker heartbeat, scheduler/provider-work mode, complete live queue observation, paused queues, and long-running work; the public health response intentionally remains a fast connectivity/deployment probe. Blind spots remain: external uptime, storage/ClamAV/email/provider execution health, outbound event delivery, policy-backed queue-depth alerts, cost anomaly notifications, latency/error trends across every dependency, and automated poor-answer detection from production conversations.

## Technical Debt / Drift

1. **Dual content/deployment architecture:** legacy `Place`/`VenueKnowledgeEntry`/`VenuePackage` remains on the live read/materialization path beside native modules/revisions/manifests/releases.
2. **Uncommitted capability tranche:** voice, entitlements, events, feedback, location and proposal work span schema/API/UI/workers and need a reviewable commit/migration boundary.
3. **Application-only tenant enforcement:** strong tooling exists, but the large bypass/raw-SQL inventory is a permanent cognitive risk without database RLS or equivalent defense.
4. **Naming/ownership drift:** Torchiko, PathFinder, Hermes and Tochi roles are inferable but not codified in one canonical architecture note; customer email still says PathFinder.
5. **Schema-ahead behavior:** operational event delivery, outcome learning, billing and some structured response blocks imply capabilities their runtimes do not yet deliver; citations now have a bounded runtime but remain short of claim-level attribution.
6. **External readiness gaps:** authenticated core service readiness exists, but green web health still proves only DB/Redis connectivity and external provider/storage/email execution remains unproven.
7. **Documentation fragmentation:** the README is thin on setup, while numerous packet/status documents contain historically useful but stale conclusions.
8. **Deployment configuration overlap:** root Railway/Nixpacks and service Docker configurations coexist.
9. **Floating local service images:** MinIO/ClamAV local tags are not reproducible.
10. **Client/operator imbalance:** safety is achieved partly by making the operator do nearly everything, which becomes operational debt as customers grow.

Systems that should not be casually rewritten include chat turn idempotency, tenant verification gates, immutable revision/manifest evidence, upload quarantine, evaluation run identity, AI budget admission, and worker lease/recovery primitives. Their complexity protects real failure boundaries.

## Scaling Assessment

### 10 venues

The system can plausibly support ten venues if Torchiko accepts hands-on onboarding and review. The immediate pain will be source cleanup, extraction verification, package approval, guest-answer QA, support, and explaining what clients can/cannot edit. Infrastructure is not the limiting factor. A golden onboarding runbook, clear ownership, live provider monitoring, and recovery plan are prerequisites.

### 100 venues

Human queues become the constraint. Intake exceptions, content freshness, package/evaluation approvals, support, report failures, and agent questions need SLA/assignment/bulk operations and real outbound notifications. Client self-service must expand selectively. AI cost and usage instrumentation can support optimization, but infrastructure and human time need one unit-economics view. Application-only tenant enforcement and the bypass inventory deserve a focused security review.

### 1,000 venues

The current operator-centric model will not scale. Torchiko would need automated low-risk content promotion policies, sampled QA, robust multichannel incident notification, queue/worker autoscaling, tested restore/PITR, data lifecycle execution, stronger tenant defense in depth, partition/retention plans for chat/analytics/audit data, and load/concurrency evidence. Cross-venue knowledge should remain explicitly permissioned; it should not be created by weakening venue isolation. These are future requirements, not reasons to pause ten-venue learning.

## Current Blockers

- No current, retained, realistic end-to-end venue onboarding/publish/chat/report evidence.
- Provider-backed chat, agents, media analysis, evaluation, report generation, and voice were not running locally.
- Broken `/privacy` marketing link and no implemented privacy-policy surface.
- Retention/deletion policy is not executable.
- No CRM, billing collection, inbound email, or general outbound communication system.
- No operational delivery for event notifications beyond the in-app console.
- Claim-level semantic citation validation and provider-enabled citation QA remain unproven; bounded retrieved-record provenance is implemented.
- Production/staging deployment, migration parity, secrets, backups/PITR, monitoring, and current CI status are unknown.

## Top 10 Things Torchiko Should Do Next

1. **Run a golden real-venue lifecycle and keep its evidence** — onboarding through offboarding/export, including failure recovery. _Effort L; impact very high._ It converts code confidence into operational confidence and reveals the real bottleneck.
2. **Make provider outages explicit in guest UX and operations** — distinguish unavailable, rejected, timed out, and ambiguous outcomes; alert the operator. _Effort S–M; impact high._ It protects visitor trust and shortens incident response.
3. **Ship a truthful privacy surface and executable retention plan** — fix `/privacy`, decide the 12 retention questions, implement/test deletion. _Effort M–L; impact very high._ It removes a customer/compliance blocker.
4. **Stabilize the current uncommitted capability tranche** — review migrations, commit coherently, deploy to staging, and run voice/location/feedback/event/entitlement smoke tests. _Effort M; impact high._ It turns a large local integration into a known release.
5. **Add one real notification delivery channel** — start with operator email or Slack for P0/P1 operational events, with dedupe/retry/audit. _Effort M; impact high._ It makes the attention console proactive.
6. **Converge the content read path** — publish an explicit legacy-to-native retirement plan and metrics; do not delete compatibility code prematurely. _Effort L; impact high._ It lowers defect and onboarding complexity.
7. **Deepen the safe client insight/correction loop** — the privacy-bounded visitor pulse and service-led correction request now exist; add calibrated trend/context depth without exposing raw conversations or direct publication. _Effort M; impact high._ It increases customer value without abandoning review safety.
8. **Verify and improve recovery/production observability** — current backup/PITR state, restore drill, worker/scheduler/provider/storage health, queue depth and cost anomalies. _Effort M; impact high._ It makes real customers supportable.
9. **Make agent model semantics honest** — align identity model configuration with actual execution and add a measured outcome-to-review loop. _Effort M; impact medium-high._ It prevents false control/learning claims and enables optimization.
10. **Create a minimal lead-to-onboarding record, not a full CRM** — capture prospect/company/contact/status/owner and conversion to tenant. _Effort M; impact medium-high._ It closes the current acquisition handoff without building outreach automation too early.

## 5 Things We Should Explicitly NOT Work On Yet

1. A city/territory-scale shared knowledge graph before the venue read path converges.
2. Autonomous outbound sales or support email before approvals, deliverability, CRM records, and event delivery exist.
3. A custom billing engine; use a provider only after pricing and entitlements stabilize.
4. Self-modifying or “self-learning” agents; first measure outcomes and require reviewable policy changes.
5. A wholesale UI redesign; the current design system and primary surfaces are already coherent.

## 5 Areas Already Strong Enough to Leave Alone for Now

1. Chat turn idempotency and durable claim/finalization primitives.
2. Tenant/static-boundary verification tooling and public-surface manifest discipline.
3. Upload admission, quarantine, malware and resource-budget safeguards.
4. Immutable content/package/evaluation evidence and audit-oriented lifecycle design.
5. The visual foundation of the client portal, onboarding journey, and admin workspace.

## If I Were Explaining Torchiko's Current State to Tom in 5 Minutes

You have a real venue product with a surprisingly serious operating system behind it. A visitor can reach a polished venue guide, a client can onboard and ask for support, and you can manage content, releases, reports, AI costs, evaluations, agents, and exceptions from a strong admin workspace. The system has more safeguards than most early products: it is careful about tenant scope, retries, duplicate AI requests, bad uploads, publishing evidence, and human approvals.

What looks more complete than it is is everything around the edges of that core. Voice, location, event delivery, agent learning, billing, and communications all have varying amounts of foundation, but they are not equally usable. Citations now expose bounded retrieved-record provenance, not claim-level semantic proof. CRM and outreach basically do not exist in the audited baseline. Agents can run and ask questions, but they do not learn automatically, and rich tools depend on an external bridge. Clients see a polished but intentionally narrow portal, leaving your team to do most of the work.

The best news is that the core is strong enough for controlled customers. The caution is that this audit did not prove one realistic venue all the way through onboarding, publication, grounded live AI, reporting, support, and recovery. Do that next. Fix the privacy link and outage message, turn on one real alert channel, verify backups/provider health, and let the resulting operational pain—not speculative architecture—choose the next build. If that golden flow becomes boring and repeatable, ten venues are realistic; the system’s human workload, not its database, will determine how quickly you get to one hundred.

## Audit limitations

No credentials, production data, provider dashboards, browser profiles, or external services were accessed. The current remote CI/deployment state, production/staging database migration parity, current Supabase backup/PITR configuration, actual email delivery, real AI output quality, live voice/WebRTC, external agent bridges, and real-device/deployed mobile rendering remain unverified. After this audit snapshot, deterministic local Chromium screenshots added bounded phone/tablet/desktop evidence for Guest routing, the single-venue portal and remote onboarding only.

## CRM/outreach branch delta (2026-08-20)

The isolated CRM foundation branch adds the prospect and outreach operational system described in `IMPLEMENTATION_CRM_FOUNDATION.md` and `IMPLEMENTATION_PROSPECT_OUTREACH_OPERATIONS.md`. Outbound and inbound adapters are implemented but dark by default; this does not change the deployed-production claim in this document.
