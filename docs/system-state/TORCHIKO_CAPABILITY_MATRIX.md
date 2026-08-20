# Torchiko Capability Matrix

**As of:** 2026-08-19 · **Code audited:** current working tree on `codex/torchiko-cloud-staging-20260819` at HEAD `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b`.

Use this file to answer “does Torchiko already have this?” Status refers to actual implementation, not plans. “Usable” distinguishes a local/code-supported capability from something proven against live providers or customers.

## Product ownership in one minute

| Name          | What it actually owns today                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Torchiko      | Umbrella/customer-facing product identity; not a separate code package.                                              |
| PathFinder    | The repository and implemented venue application: public guide, client portal, operator OS, data and workers.        |
| PathFinder OS | Internal/admin surface inside the dashboard.                                                                         |
| Tochi         | Character/assistant presentation and behavior system; only a development character pack is currently verified.       |
| Hermes        | Optional external command/provider supported by the agent bridge; its runtime and memory are not in this repository. |

## Visitor and public experience

| Capability                         | Status                       | Usable now?                    | Owner / implementation                                                                         | What remains                                                          |
| ---------------------------------- | ---------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Marketing site                     | IMPLEMENTED BUT NEEDS POLISH | Yes                            | `apps/web/app/page.tsx`                                                                        | Replace personal `mailto:` acquisition; add the missing privacy page. |
| Public venue page                  | PRODUCTION-READY             | Yes with live venue            | `apps/web/app/[venueSlug]`; `packages/api/src/routers/venue.ts`                                | Verify real published venue data.                                     |
| Guest chat                         | IMPLEMENTED BUT NEEDS POLISH | Yes when provider enabled      | `apps/web/app/[venueSlug]/chat`; `VenueChatExperience.tsx`; `packages/api/src/routers/chat.ts` | Better outage messages; provider-backed QA.                           |
| Embedded widget                    | IMPLEMENTED BUT NEEDS POLISH | Yes                            | `apps/web/app/embed/[venueSlug]`; widget-ready API/origin policy                               | Cross-site staging smoke and real embed customers.                    |
| Second-layer/employee experience   | IMPLEMENTED BUT NEEDS POLISH | Conditional                    | `[secondLayerKey]/chat`; chat authorization/context code                                       | Operational key provisioning and real employee-content QA.            |
| Conversation persistence           | PRODUCTION-READY             | Yes                            | conversation/session/turn models; `guest-chat-turn-actions.ts`                                 | Retention/deletion policy.                                            |
| Idempotent chat retry              | PRODUCTION-READY             | Yes                            | operation ID reservation/claim/finalization in `chat.ts` and DB helpers                        | Preserve during all chat changes.                                     |
| Suggested questions                | PRODUCTION-READY             | Yes                            | guest-design/engagement-question contracts and chat UI                                         | Measure usefulness per venue.                                         |
| Semantic retrieval                 | PRODUCTION-READY             | Yes                            | `packages/db/src/helpers/semantic-search.ts`; pgvector migration/schema                        | Native-content cutover and relevance evaluation.                      |
| Public/private/employee visibility | PRODUCTION-READY             | Yes                            | knowledge/place visibility plus context builder                                                | Continue authorization regression tests.                              |
| Structured answer blocks           | IMPLEMENTED BUT NEEDS POLISH | Yes, uneven generator coverage | `packages/contracts/src/guest-response.ts`; `ResponseRenderer.tsx`                             | Align generator outputs with the broad contract.                      |
| Source citations                   | SCAFFOLDED                   | No                             | citation contract/renderer                                                                     | Build provenance-aware retrieval-to-output validation.                |
| Multilingual chat                  | IMPLEMENTED BUT NEEDS POLISH | Yes, model-dependent           | `LanguagePicker.tsx`; language passed into chat/context                                        | Quality evals; no dedicated translation service.                      |
| Location resolver                  | PARTIALLY IMPLEMENTED        | Limited                        | `packages/api/src/routers/location.ts`; location models/migration                              | Authoring UI, real anchor data, map presentation.                     |
| Maps / turn-by-turn routing        | DOCUMENTED ONLY              | No                             | context explicitly says location is needed for directions                                      | Routing graph/provider and safe authoring.                            |
| Realtime voice                     | PARTIALLY IMPLEMENTED        | Feature-gated; not verified    | `VoiceControl.tsx`; `routers/voice.ts`; `packages/ai/src/realtime-voice.ts`                    | Provider-enabled staging/WebRTC/quota smoke.                          |
| Message feedback/survey            | IMPLEMENTED BUT NEEDS POLISH | Code-supported                 | `routers/feedback.ts`; feedback model/UI                                                       | Operator closed loop and production smoke.                            |
| Visitor rate limiting              | PRODUCTION-READY             | Yes                            | chat/voice/widget API policies, Redis-backed limits                                            | Load-test threshold policy.                                           |
| Visitor privacy notice             | IMPLEMENTED BUT NEEDS POLISH | Basic notice yes               | chat shell/copy                                                                                | Full `/privacy` route and retention execution.                        |
| Accessibility contracts            | PRODUCTION-READY             | Yes at tested component level  | `PacketAccessibility.test.tsx`; `pnpm test:accessibility`                                      | Full keyboard/screen-reader/browser journey.                          |
| Mobile responsive foundation       | IMPLEMENTED BUT NEEDS POLISH | Likely                         | responsive components; browser-foundation tests                                                | Independent mobile visual smoke suite.                                |
| Tochi character mode               | IMPLEMENTED BUT NEEDS POLISH | Development only               | character contracts/assets; `VenueChatShell.tsx`                                               | Approved/publishable art pack and live rollout.                       |

## Client experience

| Capability                  | Status                       | Usable now?             | Owner / implementation                                        | What remains                                                 |
| --------------------------- | ---------------------------- | ----------------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| Clerk sign-in/sign-up       | PRODUCTION-READY             | Yes                     | `packages/auth`; dashboard auth routes/middleware             | Verify production Clerk configuration.                       |
| Tenant/org provisioning     | IMPLEMENTED BUT NEEDS POLISH | Yes                     | Clerk webhook; tenant/membership actions                      | Operational webhook/delivery monitoring.                     |
| Simple client home          | PRODUCTION-READY             | Yes                     | `DashboardOverview.tsx`; portal router                        | Populate with live value/insights.                           |
| Multi-venue selection       | PRODUCTION-READY             | Yes                     | client home query and venue selector                          | Real multi-venue customer QA.                                |
| Remote onboarding           | IMPLEMENTED BUT NEEDS POLISH | Yes                     | `RemoteOnboardingJourney.tsx`; portal onboarding router       | Golden full lifecycle proof.                                 |
| Resumable file uploads      | PRODUCTION-READY             | Yes locally             | `IntakeFileUpload.tsx`; intake-upload router; storage helpers | Cloud object-store/large-file smoke.                         |
| Website/staff-note intake   | IMPLEMENTED BUT NEEDS POLISH | Yes                     | portal onboarding/intake flows                                | Provider-backed extraction validation.                       |
| Client content publishing   | Not exposed by design        | No                      | client inputs create review work; admin release path          | Keep human review; add bounded proposals/corrections.        |
| Client content editing      | PARTIALLY IMPLEMENTED        | Narrow                  | onboarding/support; legacy client routes redirect             | Safe correction proposal UI.                                 |
| Client analytics            | PARTIALLY IMPLEMENTED        | No dedicated view       | analytics route redirects; internal analytics exists          | Read-only high-value insight summary.                        |
| Client chat logs            | PARTIALLY IMPLEMENTED        | Not directly            | internal admin chat logs                                      | Privacy-aware client summary if product requires it.         |
| Weekly reports              | IMPLEMENTED BUT NEEDS POLISH | Published reports yes   | `(app)/weekly-reports`; report worker/DB lifecycle            | Prove generation/publication with real data.                 |
| Support cases               | PRODUCTION-READY             | Yes                     | `SupportWorkspace.tsx`; `routers/support.ts`                  | Email/SLA channel integration.                               |
| Operational updates         | IMPLEMENTED BUT NEEDS POLISH | Yes                     | dashboard operational-update routes/router                    | External delivery/notification.                              |
| Roles                       | IMPLEMENTED BUT NEEDS POLISH | Yes                     | owner/admin/member membership model; Clerk org                | More granular product permissions if demanded.               |
| Entitlements/plans          | PARTIALLY IMPLEMENTED        | Internal/code-supported | product-entitlement router/models/current migrations          | Stabilize migration and connect commercial billing.          |
| Billing collection/invoices | SCAFFOLDED                   | No                      | plan/billing visibility fields only                           | Select hosted provider; checkout, invoicing, reconciliation. |
| Data export/offboarding     | IMPLEMENTED BUT NEEDS POLISH | Operator-led            | offboarding admin/router/helpers                              | Customer-visible request flow and deletion completion.       |

## Admin and operations

| Capability                          | Status                       | Usable now?               | Owner / implementation                                        | What remains                                           |
| ----------------------------------- | ---------------------------- | ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Admin command center                | PRODUCTION-READY             | Yes                       | `apps/dashboard/app/(admin)/admin`; command center components | Real operational volume.                               |
| Client directory/create client      | PRODUCTION-READY             | Yes                       | admin directory/new routes and routers                        | CRM-to-client transition.                              |
| Venue workspace                     | PRODUCTION-READY             | Yes                       | `ClientWorkspaceShell.tsx` and venue route group              | Reduce legacy/native decision burden.                  |
| Intake review                       | IMPLEMENTED BUT NEEDS POLISH | Yes                       | admin intake UI/router/helpers                                | Real source cohort proof and bulk exception handling.  |
| Media workbench                     | IMPLEMENTED BUT NEEDS POLISH | Provider-dependent        | `MediaIngestionWorkbench.tsx`; `media-ingestion.ts`           | Live multimodal tests; dedicated OCR only if needed.   |
| Knowledge proposals                 | PARTIALLY IMPLEMENTED        | Current working tree      | knowledge-proposal router/UI/migration                        | Staging integration and client correction entry point. |
| Content revision/publication        | IMPLEMENTED BUT NEEDS POLISH | Yes                       | native content models/actions/admin components                | Converge live read path.                               |
| Legacy content manager              | LEGACY / SUPERSEDED          | Yes                       | `LegacyContentManager.tsx`; legacy routers/actions            | Measured retirement, not immediate deletion.           |
| Package manifests                   | IMPLEMENTED BUT NEEDS POLISH | Yes                       | venue-package router/contracts/manifest services              | Golden package/release exercise.                       |
| Native releases/deployment history  | IMPLEMENTED BUT NEEDS POLISH | Yes                       | native-release UI; deployment helpers/models                  | Live rollback/forward verification.                    |
| Content freshness/audits            | IMPLEMENTED BUT NEEDS POLISH | Yes                       | freshness review UI/helpers; worker scripts                   | Scheduler/notification operational proof.              |
| Evaluation operations               | IMPLEMENTED BUT NEEDS POLISH | Yes when provider enabled | evaluation admin UI, models, worker                           | Real datasets and regression history.                  |
| Chat-log review/private notes       | PRODUCTION-READY             | Yes                       | admin chat-log routes/components                              | Retention and support policy.                          |
| Support operations                  | PRODUCTION-READY             | Yes                       | `SupportOperationsView.tsx`; support admin routers            | Assignment/SLA notifications at scale.                 |
| AI incident kill switch             | PRODUCTION-READY             | Yes                       | global AI controls/config/actions                             | Production alert/runbook exercise.                     |
| AI cost/budget administration       | IMPLEMENTED BUT NEEDS POLISH | Yes                       | AI cost/budget forms; usage/budget models                     | Unite non-AI unit costs and validate price updates.    |
| Attention console                   | IMPLEMENTED BUT NEEDS POLISH | Yes                       | `attention-console.ts`; `OperationsAttentionConsole.tsx`      | Delivery/SLA/bulk actions.                             |
| Operational events                  | IMPLEMENTED BUT NEEDS POLISH | In-app                    | models/helper/actions; chat/voice/eval/proposal producers     | More producers and external delivery.                  |
| Event email/SMS/push/Slack/webhook  | SCAFFOLDED                   | No                        | `OperationalEventDelivery` schema                             | Dispatcher, provider, subscriptions, retry/audit.      |
| Admin impersonation/tenant override | IMPLEMENTED BUT NEEDS POLISH | Platform-admin only       | impersonate API; middleware/access context                    | Production audit/runbook verification.                 |
| External credentials                | PRODUCTION-READY             | Yes internally            | credentials UI/models/actions                                 | Operational rotation testing.                          |
| Dangerous-action safeguards         | PRODUCTION-READY             | Yes                       | audited action helpers, lifecycle constraints, confirmations  | Continue source gates and threat reviews.              |
| CRM/pipeline                        | DOCUMENTED ONLY              | No                        | no domain implementation                                      | Minimal lead record or integration.                    |
| Outreach/sequences                  | DOCUMENTED ONLY              | No                        | outreach-steward prompt is not execution                      | CRM, approvals, deliverability, send safety.           |
| Refund management                   | DOCUMENTED ONLY              | No                        | no payments domain                                            | Payment provider and policy.                           |
| Meeting scheduling                  | DOCUMENTED ONLY              | No                        | no calendar integration                                       | Demand-driven integration later.                       |

## AI, agents, quality, and communications

| Capability                            | Status                       | Usable now?               | Owner / implementation                                     | What remains                                                 |
| ------------------------------------- | ---------------------------- | ------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| Central text gateway                  | PRODUCTION-READY             | Yes with Anthropic key    | `packages/ai/src/anthropic.ts`; model registry             | Live provider SLO verification.                              |
| OpenAI embeddings                     | PRODUCTION-READY             | Yes with key              | `openai-embeddings.ts`; embedding registry                 | Freshness monitoring at production scale.                    |
| Provider-neutral capability routing   | PARTIALLY IMPLEMENTED        | Current working tree      | `capability-routing.ts`; routed-generation/workload config | Staging fallback/health smoke and UI clarity.                |
| Model registry/pricing                | PRODUCTION-READY             | Yes                       | `model-registry.ts`; `embedding-model-registry.ts`         | Price update ownership and validation.                       |
| AI budget admission/reservation       | PRODUCTION-READY             | Yes                       | `packages/ai/src/budget.ts`; DB budget actions             | Production anomaly alerting.                                 |
| AI usage/cost/latency records         | PRODUCTION-READY             | Yes                       | AI usage helpers/events/daily rollup                       | Non-AI cost integration.                                     |
| Durable agent identities              | IMPLEMENTED BUT NEEDS POLISH | Yes                       | agent schema/admin routers/UI                              | Clarify configured vs executed model.                        |
| Direct Anthropic agent runs           | IMPLEMENTED BUT NEEDS POLISH | Yes when provider enabled | `apps/workers/src/processors/agent-run.ts`                 | Live smoke; direct mode is text-only.                        |
| Codex bridge agent                    | PARTIALLY IMPLEMENTED        | External runner required  | `agent-bridge-runner.ts`; bridge API                       | Installed CLI, machine credential, staging smoke.            |
| Claude bridge agent                   | PARTIALLY IMPLEMENTED        | External runner required  | same                                                       | Same.                                                        |
| Hermes bridge agent                   | PARTIALLY IMPLEMENTED        | External runner required  | same                                                       | Hermes runtime is outside repo; verify command/API contract. |
| OpenAI-compatible local bridge        | PARTIALLY IMPLEMENTED        | External runner required  | same                                                       | Operational GPU/runtime and security proof.                  |
| Agent leases/retries/cancel/heartbeat | PRODUCTION-READY             | Yes                       | agent run DB helpers/worker/execution heartbeat            | Load/stuck-run production monitoring.                        |
| Agent MCP read tools                  | IMPLEMENTED BUT NEEDS POLISH | Bridge only               | `packages/api/src/mcp/read-actions.ts`; MCP registry       | Live bridge authorization/e2e tests.                         |
| Agent write tools                     | SCAFFOLDED / disabled        | No autonomous writes      | MCP registry/authority policy                              | Add only per proven, approval-gated need.                    |
| Agent delegation                      | PARTIALLY IMPLEMENTED        | Bridge-dependent          | delegation records and MCP action                          | Direct worker has no tool calls.                             |
| Agent questions                       | PRODUCTION-READY             | Yes                       | question actions/router/forms                              | Notification delivery and response SLA.                      |
| Agent approvals                       | PRODUCTION-READY             | Yes                       | approval request/decision models/routes/UI                 | More action executors only when safe.                        |
| Agent outcome observations            | SCAFFOLDED                   | Store/read only           | outcome model/form/MCP read                                | Aggregate and feed a reviewed improvement loop.              |
| Autonomous agent learning             | DOCUMENTED ONLY              | No                        | no runtime consumer                                        | Do not claim until measured/versioned/approved.              |
| Eval cases/datasets                   | IMPLEMENTED BUT NEEDS POLISH | Yes                       | eval schema/contracts/admin                                | Populate venue truth sets.                                   |
| Frozen eval runs/results              | IMPLEMENTED BUT NEEDS POLISH | Provider-gated            | evaluation worker/helpers                                  | Production run history and calibration.                      |
| Regression operational events         | IMPLEMENTED BUT NEEDS POLISH | Code-supported            | `evaluation-run.ts`; operational events                    | External delivery and live proof.                            |
| Hallucination detection               | PARTIALLY IMPLEMENTED        | Heuristics/evals only     | low-confidence chat, eval assertions, answer analysis      | Dedicated groundedness/citation metrics.                     |
| Welcome email                         | IMPLEMENTED BUT NEEDS POLISH | Yes with Resend           | Clerk webhook → welcome queue/worker                       | Brand update and delivery telemetry.                         |
| General outbound email                | DOCUMENTED ONLY              | No                        | no generic send workflow                                   | Templates, approvals, audit, limits, provider policy.        |
| Inbound email                         | DOCUMENTED ONLY              | No                        | no inbound parser/webhook/domain                           | Provider, threading, authentication, privacy.                |
| Autonomous AI email                   | DOCUMENTED ONLY              | No                        | agent prompts explicitly lack send surface                 | Keep disabled until full safety stack exists.                |

## Data, infrastructure, security, and developer experience

| Capability                      | Status                       | Usable now?          | Owner / implementation                                 | What remains                                                                   |
| ------------------------------- | ---------------------------- | -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| PostgreSQL/pgvector schema      | PRODUCTION-READY             | Yes locally          | `packages/db/prisma/schema.prisma`; 122 migrations     | Current staging/production parity.                                             |
| Prisma tenant middleware        | PRODUCTION-READY             | Yes                  | `middleware/tenant-isolation.ts`; tenant registry      | Database defense in depth at scale.                                            |
| Database RLS                    | DOCUMENTED/ABSENT            | No                   | no RLS policies found                                  | Evaluate selectively before high scale.                                        |
| Raw-SQL/bypass inventories      | PRODUCTION-READY             | Yes                  | verification scripts and approved callsites            | Keep budgets reviewed as code grows.                                           |
| Audit trails/immutable evidence | PRODUCTION-READY             | Yes                  | audit/domain action helpers, revisions/manifests/evals | Retention/legal-hold policy.                                                   |
| S3-compatible storage           | PRODUCTION-READY             | Yes locally          | storage config/helpers; MinIO local                    | Cloud storage readiness/backup smoke.                                          |
| Malware quarantine              | PRODUCTION-READY             | Yes locally          | ClamAV/upload/media policies                           | Production availability alerting.                                              |
| ZIP/resource-bomb limits        | PRODUCTION-READY             | Yes                  | media ingestion/admission tests                        | Load/hostile corpus testing.                                                   |
| Dedicated OCR                   | DOCUMENTED/ABSENT            | No                   | no OCR engine/path found                               | Add only if real documents require it; multimodal model may extract some text. |
| BullMQ queues/workers           | PRODUCTION-READY             | Yes locally          | `packages/jobs`; `apps/workers`                        | Provider mode and queue SLO monitoring.                                        |
| Schedulers                      | IMPLEMENTED BUT NEEDS POLISH | Feature-gated        | worker index/scheduler control/fanout                  | Production heartbeat and failure delivery.                                     |
| Dead-letter/redrive             | PRODUCTION-READY             | Yes                  | job records, terminal redrive/recovery scripts/tests   | Operator runbook/live exercise.                                                |
| Local staging                   | PRODUCTION-READY             | Yes                  | `scripts/local-staging.ps1`; compose                   | Pin floating MinIO/ClamAV tags.                                                |
| Web health endpoint             | IMPLEMENTED BUT NEEDS POLISH | Yes                  | `apps/web/app/api/health/route.ts`                     | Add true readiness/worker/provider/storage coverage.                           |
| Railway deploy configs          | PARTIALLY IMPLEMENTED        | Code-supported       | service Railway JSON/Dockerfiles                       | Verify actual services/domains/secrets/health.                                 |
| CI workflow                     | IMPLEMENTED BUT NEEDS POLISH | Configured           | `.github/workflows/ci.yml`                             | Current remote run status was not verified.                                    |
| Logical database backup         | IMPLEMENTED BUT NEEDS POLISH | Manual               | backup PowerShell script/test                          | Fresh encrypted archive and restore drill.                                     |
| Scheduled backup/PITR           | UNKNOWN                      | Provider-dependent   | older docs say absent on Supabase Free                 | Confirm current provider plan/settings.                                        |
| Retention/deletion executor     | PARTIALLY IMPLEMENTED        | No general execution | retention architecture/readiness/offboarding           | Policy decisions plus tested erasure/anonymization.                            |
| Public-surface inventory        | PRODUCTION-READY             | Yes                  | `public-surface-manifest.json`; verifier               | Keep updated with every route.                                                 |
| Client-bundle secret scan       | PRODUCTION-READY             | Yes                  | `verify-client-bundle-secrets.mjs`                     | Keep CI-enforced.                                                              |
| Sentry/structured logs          | IMPLEMENTED BUT NEEDS POLISH | Configurable         | Sentry setup, structured job/audit logs                | Live project/alert verification and build-warning cleanup.                     |
| README/setup guide              | PARTIALLY IMPLEMENTED        | Basic                | root `README.md`, scripts, this handoff                | 15-minute clean setup and canonical doc index.                                 |

## Important “no” answers

- There is no implemented CRM, sales pipeline, outreach sequence engine, meeting scheduler, refund system, Stripe/billing collection, general email composer/sender, inbound email, turn-by-turn navigation, autonomous agent learning, database RLS, or operational multichannel event dispatcher.
- Citations, billing visibility, outcome observations, event delivery rows, and agent identity model names must not be interpreted as proof that their implied end-to-end capabilities exist.
- Passing tests/builds do not prove current cloud deployment, provider keys, live AI quality, mail deliverability, backup/PITR, or real customer adoption.

## CRM/outreach branch delta (2026-08-20)

On the isolated CRM correction branch, platform prospect navigation, saved views, campaigns, verified read/draft agent tools, human-reviewed frozen send batches, a transactional outbox, and linked live-venue intelligence are implemented. The former prospect Resend runtime is retired. Gmail adapter and inbound orchestration foundations are tested, but production OAuth/client, Pub/Sub persistence, watch/reconciliation scheduling, and provider-health composition remain incomplete. Delivery is configuration- and database-disabled and has not received a live smoke test.
