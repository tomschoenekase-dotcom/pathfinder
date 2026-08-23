# Torchiko Audit Backlog

**Snapshot:** 2026-08-19 · branch `codex/torchiko-cloud-staging-20260819` · HEAD `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b` plus the current dirty working tree.

This is a prioritized consequence of the audit, not a repository TODO dump. “Before acquisition” means before deliberately adding more live venue customers, not before accepting any design partner. “Autonomous” means a coding agent can safely implement the change without product/legal/credential decisions; verification may still require Tom.

## P0 — Broken / Dangerous

No active cross-tenant leak, destructive migration, secret exposure, or failing build was confirmed. The P0 list is therefore short and focused on conditions that become dangerous once real customer data or public traffic is placed in the system.

### P0.1 — Decide and execute customer-data retention/deletion

- **Problem:** Retention is represented as an inventory/readiness contract, but there is no general deletion/retention executor. Guest conversations, uploads, support records, analytics, and derived AI data can accumulate without an executable policy.
- **Evidence:** `docs/retention-policy-architecture.md`; retention models/helpers in `packages/db`; offboarding/export code; readiness intentionally remains false until all required decisions exist.
- **Affected system:** Privacy, database, uploads, analytics, support, AI usage, offboarding.
- **Recommended change:** Have the owner/legal decision-maker set the required policy values; implement dry-run inventories, dependency-aware deletion/anonymization, legal holds, audit receipts, replay safety, and restore-aware tests.
- **Why it matters:** Real client and visitor data without an executable policy creates compliance and trust risk and makes later deletion much harder.
- **Effort:** L
- **Dependencies:** Product/legal decisions; storage inventory; backup policy.
- **Before more venue acquisition:** **Yes**, at least policy decisions and a tested manual deletion path.
- **Codex autonomous:** **No** for policy; **partly** for implementation after explicit decisions.

### P0.2 — Re-establish current backup/PITR and restore evidence

- **Problem:** A careful logical-backup path and an older successful restore rehearsal exist, but current Supabase backup/PITR state and recovery time are unknown. Earlier evidence says the Free plan had no scheduled backups or PITR.
- **Evidence:** `scripts/prepare-supabase-logical-backup.ps1`; `scripts/supabase-logical-backup.test.mjs`; `docs/pathfinder-v2-cutover-execution-status.md`; `docs/database-incident-stop.md`.
- **Affected system:** Production database, business continuity, migrations.
- **Recommended change:** Confirm provider settings directly; create a fresh encrypted logical archive outside the repo; restore into an isolated PostgreSQL 17/pgvector environment; validate tenant/content/chat/package counts and record RPO/RTO. Upgrade provider recovery if the accepted RPO requires it.
- **Why it matters:** The data model is large and migration-heavy; an untested or manual-only recovery path can turn one operational error into company-level data loss.
- **Effort:** M
- **Dependencies:** Owner authorization, database credential prompt, safe external backup location, possibly paid Supabase plan.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **No**; credentials, cost, and production backup authority are required. Codex can prepare and verify the runbook.

### P0.3 — Prove the uncommitted migration tranche in disposable and staging databases

- **Problem:** The audited working tree adds eleven sequential migrations for entitlements, routing observability, voice, conversation intelligence, operational events, proposals, location, widget plans, multimodal usage, voice rollups, feedback, and agent questions. They are not a clean reviewed release boundary.
- **Evidence:** untracked directories `packages/db/prisma/migrations/20260819140000_*` through `20260819155000_*`; 553-line schema addition in the tracked diff; dirty API/UI/worker changes.
- **Affected system:** Database, public API, AI, analytics, admin, deployment.
- **Recommended change:** Review ordering and constraints, run disposable migration from a production-lineage schema, exercise downgrade-by-forward-fix assumptions, deploy to staging, run public-surface/tenant/raw-SQL/browser smoke gates, and commit as one documented release or a carefully ordered series.
- **Why it matters:** A green TypeScript build cannot prove schema compatibility. This tranche touches critical public and operational paths.
- **Effort:** M
- **Dependencies:** Clean change ownership, staging database authorization, current backup.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Partly**; local/disposable work is safe, staging deployment requires authority.

## P1 — High-Value Near-Term

### P1.1 — Create and retain one golden venue lifecycle

- **Problem:** Individual subsystems are deep, but no current venue proves prospect/client creation → onboarding → mixed-media intake → review → package/evaluation → release → grounded chat → feedback/report/support → export/offboarding.
- **Evidence:** Local staging had 20 synthetic clients/venues but `August test` had no content, packages, reports, or onboarding artifacts; provider workers were disabled.
- **Affected system:** Entire product and operations model.
- **Recommended change:** Build a realistic non-sensitive fixture and scripted acceptance checklist, preserve IDs/screenshots/audit rows, inject failure/retry cases, and rerun it for each release.
- **Why it matters:** This is the fastest way to discover which impressive modules actually combine into a sellable service.
- **Effort:** L
- **Dependencies:** Provider-enabled staging, representative source media, owner-defined acceptance answers.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Partly**; fixture/runbook yes, live provider and acceptance review no.

### P1.2 — Replace ambiguous provider-down chat behavior

- **Problem:** In provider-disabled local staging, a submitted guest message displayed “The outcome of this message is not confirmed. Retry the same message safely.” This is appropriate only for uncertain network outcomes, not known provider unavailability.
- **Evidence:** Browser exercise of `/august-test/chat`; failures from `chat.send` and `analytics.trackEvent`; error state in `VenueChatExperience.tsx` and durable turn handling in `chat.ts`.
- **Affected system:** Guest chat, reliability, support, operational events.
- **Recommended change:** Preserve idempotent retry but map server/provider codes into unavailable, timed-out/ambiguous, rate-limited, and content-unavailable messages; emit/resolve an operational event and avoid retry loops.
- **Why it matters:** Visitors need truthful recovery guidance, and operators need to know whether AI is down.
- **Effort:** S
- **Dependencies:** Stable public error-code contract.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Yes**, with tests; live provider verification still needs credentials.

### P1.3 — Publish a real privacy page and align data disclosures

- **Problem:** The marketing footer links to `/privacy`, but no route exists. Existing guest copy does not substitute for a full policy.
- **Evidence:** `apps/web/app/page.tsx:265`; production build route list has no `/privacy`.
- **Affected system:** Marketing, guest trust, privacy/compliance.
- **Recommended change:** Obtain approved policy text covering conversations, anonymous identifiers, uploads, providers, retention, rights and contact; add the route, metadata, accessible layout, tests and link checking.
- **Why it matters:** A broken legal/trust link is visible to every prospective customer and visitor.
- **Effort:** S
- **Dependencies:** Owner/legal-approved wording and contact details.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **No** for policy text; **yes** for implementation after approval.

### P1.4 — Deliver P0/P1 operational events outside the admin UI

- **Problem:** The event center is persistent and deduplicated but passive. Email/SMS/push/Slack/webhook delivery types exist without a dispatcher.
- **Evidence:** `OperationalEvent`/`OperationalEventDelivery` in `schema.prisma`; `packages/db/src/helpers/operational-events.ts`; attention console; no delivery producer/worker found.
- **Affected system:** Incident response, agents, evaluations, chat, voice, intake/support.
- **Recommended change:** Select one channel (operator email or Slack), implement subscription policy, transactional outbox/worker, retry/suppression/dedupe, delivery audit, test mode, and escalation timing.
- **Why it matters:** An inbox nobody is looking at does not protect live venues.
- **Effort:** M
- **Dependencies:** Channel/provider choice, recipient policy, secrets, quiet-hours/escalation decisions.
- **Before more venue acquisition:** **Yes** for high-severity events.
- **Codex autonomous:** **Partly**; provider/account decisions require Tom.

### P1.5 — Expand health from connectivity to service readiness

- **Problem:** `/api/health` checks only database and Redis queue connectivity. It can be green when workers, schedulers, storage, ClamAV, AI providers, email, or migrations are broken.
- **Evidence:** `apps/web/app/api/health/route.ts`; live response during audit.
- **Affected system:** Deployment, observability, incident response.
- **Recommended change:** Keep a fast liveness route, add authenticated readiness/operations checks for migration revision, worker heartbeat, scheduler freshness, queue age/depth, storage/ClamAV and recent provider outcomes; alert on SLOs rather than directly calling every provider on each request.
- **Why it matters:** Operators currently cannot answer “are chats and background work actually working?” from the health endpoint.
- **Effort:** M
- **Dependencies:** Heartbeat model and alert delivery.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Yes** for code/tests; deployment alerts need configuration.

### P1.6 — Give clients a bounded insight and correction loop

- **Problem:** Client analytics and authoring routes intentionally redirect home. Clients cannot see top questions/content gaps/feedback or propose precise corrections outside broad onboarding/support.
- **Evidence:** `(app)/legacy-route-boundary.test.ts`; redirects for analytics and old venue authoring; full analytics/content tools exist only under admin.
- **Affected system:** Client portal, analytics, content operations, support load.
- **Recommended change:** Add a read-only weekly insight summary and “suggest a correction” flow that creates a reviewable knowledge proposal; never direct-publish.
- **Why it matters:** Customers receive more visible value and can improve accuracy without weakening editorial safety.
- **Effort:** M
- **Dependencies:** Stable proposal workflow and client permissions.
- **Before more venue acquisition:** **No** for design partners; **yes** before broad self-serve sales.
- **Codex autonomous:** **Partly**; product scope/wording needs approval.

### P1.7 — Define and measure the legacy-to-native content cutover

- **Problem:** Guest retrieval still reads legacy Places/Knowledge while native modules/revisions/manifests/releases are the preferred lifecycle. Compatibility materialization has known field limits.
- **Evidence:** `semantic-search.ts`; `legacy-content-actions.ts`; native content and deployment helpers; admin “Legacy compatibility” UI.
- **Affected system:** Knowledge, retrieval, packages, release, admin, migrations.
- **Recommended change:** Document one authoritative read/write path per content type, add parity metrics and shadow reads, block new unneeded legacy writes, migrate a fixture cohort, then retire only after measured equivalence.
- **Why it matters:** Dual systems multiply defects, training burden, and migration risk.
- **Effort:** L
- **Dependencies:** Golden lifecycle, production content inventory, relevance tests.
- **Before more venue acquisition:** **Start before**, completion can be incremental.
- **Codex autonomous:** **No** as a whole; safe instrumentation steps can be autonomous.

### P1.8 — Establish minimal lead-to-client continuity

- **Problem:** Acquisition is a personal `mailto:` followed by manual client creation. No prospect/company/contact/stage/owner history exists.
- **Evidence:** marketing demo link; absence of CRM domain models/routes; `AdminCreateClientForm.tsx` begins after the sale.
- **Affected system:** Marketing, sales, onboarding, auditability.
- **Recommended change:** Implement or integrate a minimal lead record with organization/contact, consent/source, stage, owner, next step, notes, and atomic conversion to tenant/venue. Avoid sequences and scoring initially.
- **Why it matters:** Real prospects otherwise fall between inboxes and lose history at onboarding.
- **Effort:** M
- **Dependencies:** Buy-vs-build and email/calendar decisions.
- **Before more venue acquisition:** **Recommended**, not blocking a few design partners.
- **Codex autonomous:** **No** for product/integration choice; implementation after decision can be autonomous.

### P1.9 — Verify voice, model fallback, and agent bridges in staging

- **Problem:** These are substantial code paths but were unavailable in local runtime; direct agent identity model configuration also does not directly control the registry model used.
- **Evidence:** `voice.ts`, `realtime-voice.ts`, `capability-routing.ts`, `agent-run.ts`, `agent-bridge-runner.ts`; local worker `provider-disabled-health-only`.
- **Affected system:** AI platform, visitor voice, agents, cost controls.
- **Recommended change:** Create provider-enabled smoke tests with strict spend caps; verify entitlement/quota/fallback/usage records, cancellation, bridge machine credentials and failure recovery; align or relabel identity model selection.
- **Why it matters:** These features should not be marketed or relied upon until their real provider boundaries are proven.
- **Effort:** M
- **Dependencies:** Provider credentials, staging, spend authorization, bridge binaries.
- **Before more venue acquisition:** **Yes if sold**, otherwise keep disabled.
- **Codex autonomous:** **No** for credentials/external execution; yes for test harnesses.

### P1.10 — Add citations or remove the implied capability

- **Problem:** Citation response blocks and UI exist, but the chat path does not construct source citations from retrieved records.
- **Evidence:** `packages/contracts/src/guest-response.ts`; `ResponseRenderer.tsx`; no citation generation in `packages/api/src/routers/chat.ts` or `venue-context.ts`.
- **Affected system:** Guest trust, knowledge provenance, quality evaluation.
- **Recommended change:** Attach stable source/provenance IDs to retrieval results, constrain the model to referenced claims, validate citations server-side, and test missing/stale sources; until then do not advertise citations.
- **Why it matters:** Grounding is more valuable when visitors/operators can understand the source, especially for changing venue facts.
- **Effort:** M
- **Dependencies:** Native/legacy provenance strategy.
- **Before more venue acquisition:** **No**, unless citations are promised contractually.
- **Codex autonomous:** **Partly**; UX/product policy should be approved.

## P2 — Product / Quality Improvements

### P2.1 — Normalize Torchiko / PathFinder / Tochi / Hermes vocabulary

- **Problem:** External product, internal OS, character, and external runner names are mixed; the welcome email still says PathFinder and links `pathfinder.ai`.
- **Evidence:** marketing/client UI, `send-welcome-email.ts`, `README.md`, agent bridge code.
- **Affected system:** Brand, documentation, onboarding, architecture.
- **Recommended change:** Publish a one-page ownership glossary and apply it to email/UI/docs without renaming stable code mechanically.
- **Why it matters:** Customers and future agents otherwise infer different product boundaries.
- **Effort:** S
- **Dependencies:** Founder naming decision.
- **Before more venue acquisition:** **Preferably**.
- **Codex autonomous:** **No** for naming; yes for mechanical application after approval.

### P2.2 — Add a real mobile visual smoke suite

- **Problem:** Responsive DOM/accessibility tests pass, but independent mobile visual inspection could not be completed in this audit.
- **Evidence:** browser viewport remained 1280×720; `test:browser-foundation` and responsive classes provide indirect evidence.
- **Affected system:** Public chat, onboarding, client/admin UI.
- **Recommended change:** Add Playwright screenshots/interaction at representative phone/tablet/desktop widths for core journeys, with reduced-motion and keyboard cases.
- **Why it matters:** The guest experience will often be mobile and embedded.
- **Effort:** M
- **Dependencies:** Stable fixture data and CI browser runtime.
- **Before more venue acquisition:** **No**, but before broad QR/widget deployment.
- **Codex autonomous:** **Yes**.

### P2.3 — Complete production answer-quality evaluation

- **Problem:** Eval infrastructure is strong, but current datasets/runs and automated hallucination/retrieval quality from real conversations were not observed.
- **Evidence:** evaluation models/contracts/worker/admin; low-confidence and explicit-negative-feedback insights; governed, human-sanitized conversation-to-evaluation-case preparation with immutable provenance.
- **Affected system:** AI quality, reporting, operations.
- **Recommended change:** Continue expanding venue-specific golden questions, adversarial/out-of-scope cases, citation/retrieval metrics, provider-backed regression baselines, and human-review calibration. Sanitized production-failure sampling now has an operator workflow; it still needs staging corpus use and calibrated run history.
- **Why it matters:** Passing code tests does not prove truthful answers.
- **Effort:** L
- **Dependencies:** Golden venues, privacy policy, provider-enabled staging.
- **Before more venue acquisition:** **Begin now**; depth can grow later.
- **Codex autonomous:** **Partly**; humans must define truth and thresholds.

### P2.4 — Unify variable and human unit economics

- **Problem:** AI usage is deeply instrumented, while storage, hosting, email, monitoring, file processing and operator time are not presented per tenant/venue.
- **Evidence:** AI usage events/daily rollups/budget UI; no unified cost ledger.
- **Affected system:** Analytics, pricing, operations.
- **Recommended change:** Add a provider-neutral cost category ledger/estimates, queue/media/storage counters and optional operator-minute inputs; report uncertainty separately from invoices.
- **Why it matters:** AI optimization alone may target the wrong cost driver.
- **Effort:** M
- **Dependencies:** Pricing/cost-source policy.
- **Before more venue acquisition:** **No** for ten venues; useful before one hundred.
- **Codex autonomous:** **Partly**.

### P2.5 — Turn agent outcomes into a reviewed improvement loop

- **Problem:** Outcome observations are stored but do not influence future behavior.
- **Evidence:** `AgentOutcomeObservation` and admin form/read surfaces; no runtime consumers that update routing/prompts/reputation.
- **Affected system:** Agents, evaluations, model routing.
- **Recommended change:** Aggregate outcomes by identity/task type, expose acceptance/failure trends, propose versioned instruction/routing changes, require human approval, and compare pre/post evals.
- **Why it matters:** This makes “improvement” measurable without unsafe self-modification.
- **Effort:** M
- **Dependencies:** Enough real runs and outcome labels.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Partly**; promotion policy requires approval.

### P2.6 — Pin local infrastructure images and clarify Railway ownership

- **Problem:** Local MinIO/ClamAV use floating tags; root Railway/Nixpacks and per-service Docker configurations coexist.
- **Evidence:** compose files and Railway configs; staging verifier recognizes three services.
- **Affected system:** Developer experience, deployment reproducibility.
- **Recommended change:** Pin image digests/versions, document upgrade cadence, designate service configs canonical, and retire or clearly mark the root config.
- **Why it matters:** Builds and local behavior should not change because an upstream tag moved.
- **Effort:** S
- **Dependencies:** Tested compatible versions and deployment confirmation.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Partly**; production config removal requires confirmation.

### P2.7 — Improve repository onboarding and doc discoverability

- **Problem:** The README identifies workspaces but omits the full install/env/migrate/local-staging/debug path; historical packet docs can outrank current truth.
- **Evidence:** `README.md`, many `docs/task-packets` and execution-status files, scripts/package commands.
- **Affected system:** Developer/agent experience.
- **Recommended change:** Link this snapshot and handoff from README; add a 15-minute setup path; label historical docs; generate a command/config index.
- **Why it matters:** Future sessions repeatedly spend time rediscovering the same boundaries.
- **Effort:** S
- **Dependencies:** None.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Yes**.

### P2.8 — Remove the remaining UI/build warnings

- **Problem:** Lint warns on raw `<img>`; Next builds warn on Sentry/OpenTelemetry dynamic requires and Windows standalone link names.
- **Evidence:** `apps/web/components/PlaceCard.tsx:70`; `pnpm build` output.
- **Affected system:** Web performance, build signal quality.
- **Recommended change:** Use an appropriate optimized image path or document the exception; pin/configure supported Sentry instrumentation; test the standalone-copy behavior on the actual Linux deployment path.
- **Why it matters:** Warning-free gates preserve useful signal, though none blocked this audit.
- **Effort:** S
- **Dependencies:** Image-domain/loader decision; Sentry version guidance.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Yes** for the image; partly for telemetry dependency changes.

## P3 — Scaling / Future Architecture

### P3.1 — Add database-level tenant defense for the highest-risk tables

- **Problem:** Isolation is application-only. The bypass registry is disciplined but large.
- **Evidence:** no RLS policies found; 193 approved bypasses across 65 production files; 94 raw-SQL operations.
- **Affected system:** Security, database, all tenant data.
- **Recommended change:** Threat-model service roles and connection pooling, then pilot RLS or equivalent guarded views on a small high-risk set; retain application checks and measure operational cost.
- **Why it matters:** One missed predicate should not become a cross-tenant disclosure at scale.
- **Effort:** XL
- **Dependencies:** Production query inventory, Supabase/Prisma role strategy, performance testing.
- **Before more venue acquisition:** **Not required for ten**, reassess before one hundred.
- **Codex autonomous:** **No**.

### P3.2 — Partition/archive high-growth event and conversation data

- **Problem:** Chat turns, analytics, audit, AI usage and operational events grow continuously; retention is not yet executable.
- **Evidence:** append-heavy models and scheduled rollups in `schema.prisma`/workers.
- **Affected system:** Database performance, cost, privacy.
- **Recommended change:** After measuring growth, set indexes/partition/archive boundaries and rollup retention; test deletion with derived records.
- **Why it matters:** This becomes relevant at hundreds/thousands of venues, not today.
- **Effort:** L
- **Dependencies:** Retention policy and real volume measurements.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **No**.

### P3.3 — Autoscale workers using queue age and capability isolation

- **Problem:** Media, embeddings, evaluations, reports, agents and analytics share one worker application and finite resources.
- **Evidence:** `apps/workers/src/index.ts`, queue registry, 15 processors and schedulers.
- **Affected system:** Reliability, costs, latency.
- **Recommended change:** Instrument queue age/resource use, split only proven noisy workloads, set concurrency/admission by capability, and autoscale against SLOs.
- **Why it matters:** Premature splitting adds ops cost, but one media burst should not delay chats/reports at scale.
- **Effort:** L
- **Dependencies:** Production metrics and platform support.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **No**.

### P3.4 — Generalize place/city knowledge only after venue convergence

- **Problem:** Long-term territory knowledge is plausible, but current storage/publication/retrieval is venue-first and dual-generation.
- **Evidence:** typed native content/location anchors help; venue foreign keys and legacy Place semantics constrain sharing.
- **Affected system:** Knowledge architecture, product strategy.
- **Recommended change:** Later define explicit ownership/licensing/provenance and shared-vs-venue overlays; do not weaken tenant isolation to reuse knowledge.
- **Why it matters:** A premature graph would compound today’s migration.
- **Effort:** XL
- **Dependencies:** Native cutover, proven market need, rights model.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **No**.

## PARKED / LONG-TERM

| Idea to park                               | Why not now                                                                        | Revisit trigger                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Autonomous sales/support email sequences   | No CRM, deliverability controls, approval policy, or general mail domain exists.   | Stable lead records, approved templates, domain health, event delivery and human override.    |
| Self-modifying agent prompts/models        | Outcome data is sparse and no safe promotion/eval loop exists.                     | Statistically useful labeled outcomes and versioned approval workflow.                        |
| Full indoor turn-by-turn navigation        | Location V1 only resolves verified anchors; mapping/authoring data is absent.      | Multiple customers explicitly pay for routing and supply reliable map data.                   |
| Build a custom subscription/billing engine | Entitlements are still changing and no payment provider is selected.               | Validated pricing and need beyond a hosted billing provider.                                  |
| Rewrite the admin UI/design system         | Existing surfaces are coherent and accessible; operational proof is more valuable. | Measured task failures, not aesthetic preference.                                             |
| Replace BullMQ/Prisma/Next/Clerk           | Current foundations are functioning and heavily tested.                            | Demonstrated scalability, security, or vendor constraint that cannot be solved incrementally. |
| Broad consumer Torchiko network            | No validated venue cohort or shared-place rights model yet.                        | Repeatable venue operations and clear consumer acquisition loop.                              |
