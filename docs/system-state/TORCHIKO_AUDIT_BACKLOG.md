# Torchiko Audit Backlog

**Current-truth overlay:** 2026-08-25 · **Historical audit baseline:** 2026-08-19 on `codex/torchiko-cloud-staging-20260819` at `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b`.

This is a prioritized consequence of the audit, not a repository TODO dump. The machine-readable current overlay is [`torchiko-current-truth.json`](./torchiko-current-truth.json); completed historical problem statements below must be read with their current status and remaining boundary. The integrated lineage contains 182 migrations. “Before acquisition” means before deliberately adding more live venue customers, not before accepting any design partner. “Autonomous” means a coding agent can safely implement the change without product/legal/credential decisions; verification may still require Tom.

## P0 — Broken / Dangerous

No active cross-tenant leak, destructive migration, secret exposure, or failing build was confirmed. The P0 list is therefore short and focused on conditions that become dangerous once real customer data or public traffic is placed in the system.

### P0.1 — Decide and execute customer-data retention/deletion

- **Status:** **READ-ONLY DATABASE PREVIEW IMPLEMENTED 2026-08-25; POLICY AND EXECUTION REMAIN BLOCKED.** A platform administrator or separately capability-gated agent can now inspect one full client across every canonical tenant-linked/shared-scope model. Exact counts, unclassified models, platform-unscoped data, external-artifact exclusions, unresolved policy, and unavailable counts are explicit. The preview always denies execution and performs no mutation.
- **Problem:** There is still no approved general deletion/anonymization policy or executor. Guest conversations, uploads, support records, analytics, and derived AI data can accumulate without an executable policy.
- **Evidence:** `docs/retention-disposition-preview.md`; `docs/retention-policy-architecture.md`; `previewRetentionDispositionAction`; `pathfinder.retention-preview`; `pnpm test:retention-disposition-preview:disposable`; offboarding/export code.
- **Affected system:** Privacy, database, uploads, analytics, support, AI usage, offboarding.
- **Recommended change:** Have the owner/legal decision-maker classify remaining models and external artifacts and set the required policy values; then extend the preview into dependency-aware deletion/anonymization, legal holds, audit receipts, replay safety, provider/object-store coverage, and restore-aware tests.
- **Why it matters:** Real client and visitor data without an executable policy creates compliance and trust risk and makes later deletion much harder.
- **Effort:** L
- **Dependencies:** Product/legal decisions; storage inventory; backup policy.
- **Before more venue acquisition:** **Yes**, at least policy decisions and a tested manual deletion path.
- **Codex autonomous:** **Read-only preview complete**; no for policy or destructive execution without explicit decisions.

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

### P0.3 — Prove the integrated migration lineage in disposable and staging databases — LOCAL BOUNDARY RESOLVED

- **Status:** **CLEAN LOCAL/RELEASE BOUNDARY PROVEN 2026-08-25; HOSTED INTEGRATION REMAINS OWNER GATED.** The formerly uncommitted tranche is part of a clean integrated 182-migration lineage. Exact candidate release checks freeze the migration manifest, prove full disposable application, retain the lineage hash in a staging handoff, and fail closed on dirty or divergent candidates.
- **Remaining problem:** Current hosted staging migration parity, preserved-data backup evidence, exact deployed revision, and live runtime health still require the authorized owner integration workflow. Local evidence must not be promoted into a hosted-state claim.
- **Evidence:** `scripts/verify-staging-config.mjs`; `scripts/create-staging-handoff.mjs`; `scripts/staging-migration-predeploy.test.mjs`; exact release candidate and staging handoff artifacts.
- **Affected system:** Database, public API, AI, analytics, admin, deployment.
- **Recommended change:** Review and integrate only the exact admitted candidate into the owner staging branch, preserve difficult-to-recreate data with fresh backup/restore evidence, apply the checked-in predeploy, then run exact-revision hosted health and staging-profile verification.
- **Why it matters:** The local schema boundary is trustworthy; the remaining risk is confusing it with current hosted database and runtime state.
- **Effort:** M
- **Dependencies:** Owner staging integration, current preserved-data backup/restore evidence, and exact hosted target confirmation.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Local proof complete**; hosted staging deployment/migration remains owner gated under the checked-in workflow.

## P1 — High-Value Near-Term

### P1.1 — Create and retain one golden venue lifecycle

- **Status:** **LOCALLY IMPLEMENTED AND RE-PROVED 2026-08-24.** One fresh disposable run now proves client/venue creation, remote onboarding, website/interview/file intake, authoritative upload evidence, review, missing-information handoff, service-led support resolution, immutable package/evaluation evidence, explicit release and rollback, grounded provider-dark chat for every retained fixture question, visitor feedback, routine updates, report publish/read, reviewed versioned export readiness, and seven failure classes. Exact PostgreSQL, Redis, MinIO, and ClamAV resources are removed and verified absent after the run.
- **Historical problem:** Individual subsystems were deep, but no current venue composed the lifecycle into one retained proof.
- **Evidence:** `pnpm golden-venue:disposable`; `packages/api/src/remote-onboarding-disposable.integration.test.ts`; `scripts/golden-venue/fixture.json`; `docs/golden-venue-runbook.md`; static `golden-venue-fixture` release gate.
- **Affected system:** Entire product and operations model.
- **Remaining hosted proof:** Run the same fixture in an explicitly authorized synthetic staging namespace, retain deployed browser evidence, and perform a spend-bounded provider-backed quality smoke. Export readiness remains non-deleting and does not claim cancellation, revocation, delivery, or retention-policy execution.
- **Why it matters:** This is the fastest way to discover which impressive modules actually combine into a sellable service.
- **Effort:** L
- **Dependencies:** Provider-enabled staging and owner-authorized spend for the remaining live-provider quality proof.
- **Before more venue acquisition:** **Local lifecycle proof complete; hosted/provider proof remains before relying on it operationally.**
- **Codex autonomous:** **Implemented locally**; hosted provider execution and acceptance review remain gated.

### P1.2 — Replace ambiguous provider-down chat behavior — IMPLEMENTED 2026-08-24

- **Outcome:** Guest chat now carries a stable browser-safe taxonomy for provider unavailable,
  rate-limited, outcome ambiguous, content unavailable, rejected, and pre-dispatch transient failure.
  Known provider and content failures receive definite guidance without an unsafe same-operation retry.
  Ambiguous transport/provider outcomes reconcile durable history or retain an exact idempotent retry.
  Pre-reservation rate limits truthfully state that the message was not sent, then preserve the exact
  frozen message for a bounded retry. Provider route exhaustion commits a safe fallback and publishes
  a deduplicated operational event rather than presenting an unconfirmed outcome.
- **Evidence:** `GuestPublicErrorCode`; `publicTRPCError`; `chat.ts` reservation/provider-operation
  lifecycle and operational events; `VenueChatExperience.tsx`; API and browser component tests.
- **Remaining proof:** Exercise the taxonomy against a provider-enabled staging deployment and retain
  sanitized incident/event evidence. Generic unclassified transport failures intentionally remain
  ambiguous because the browser cannot prove whether the server committed the turn.
- **Affected system:** Guest chat, reliability, support, operational events.
- **Before more venue acquisition:** **Code complete; live provider proof remains.**

### P1.3 — Finalize the privacy policy and align data disclosures — IMPLEMENTATION FOUNDATION COMPLETE

- **Status:** **TRUTHFUL STATUS SURFACE IMPLEMENTED 2026-08-25; POLICY TEXT REMAINS OWNER/LEGAL GATED.** The marketing footer reaches an accessible `/privacy` route that explicitly says the final policy is under review and avoids inventing retention, rights, legal-entity, or contact commitments.
- **Remaining problem:** A status surface does not substitute for approved policy. Final wording must cover conversations, identifiers, uploads, providers, retention, rights, and an authorized contact route, and must agree with the eventual executable retention policy.
- **Evidence:** `apps/web/app/privacy/page.tsx`; marketing link tests; `privacy-retention` current-truth anchor.
- **Affected system:** Marketing, guest trust, privacy/compliance.
- **Recommended change:** Obtain approved policy text and contact details, replace the clearly marked review-state copy, then verify metadata, accessibility, link behavior, and disclosure/retention consistency.
- **Why it matters:** The broken-link defect is closed, but prospects and visitors still need final trustworthy disclosures before launch.
- **Effort:** S
- **Dependencies:** Owner/legal-approved wording and contact details.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Status route complete**; no for inventing policy text, contact details, or legal commitments; yes for mechanical application and verification after approval.

### P1.4 — Deliver P0/P1 operational events outside the admin UI — IMPLEMENTED BUT EXTERNAL GATED 2026-08-24

- **Outcome:** Tenant-owned operational events have a dark-by-default operator-email route with severity policy, destination hashing, durable materialization, deduplication, bounded batch processing, exponential retry, terminal suppression, sanitized append-only attempt audit, a non-production development sink, and a recurring BullMQ worker. Activation now fails configuration validation unless the provider-worker runtime, Redis, explicit sender/recipient, and Resend credential are all present; external and development routes cannot be selected ambiguously.
- **Evidence:** `OperationalEvent`/`OperationalEventDelivery`/`OperationalEventDeliveryAttempt` in `schema.prisma`; `packages/db/src/helpers/operational-event-deliveries.ts`; `apps/workers/src/processors/operational-event-delivery.ts`; worker scheduler integration; `docs/operational-event-delivery.md`; config, routing, processor, retry, suppression, batch-bound, and default-dark tests.
- **Affected system:** Incident response, agents, evaluations, chat, voice, intake/support.
- **Retained gates:** No external route is enabled here. Recipient selection, minimum severity, credentials, staging/live delivery proof, quiet-hours/escalation policy, and any channel beyond operator email remain owner/configuration decisions. Platform-owned pre-conversion CRM/provider events remain Founder Control Room-only and are not claimed as externally delivered.
- **Why it matters:** The delivery capability exists without inventing a wake-up policy or permitting accidental outbound alerts.
- **Effort:** M
- **Dependencies:** Owner-selected recipient/severity, provider credentials, and an authorized staging delivery canary for activation.
- **Before more venue acquisition:** **Yes** for high-severity events.
- **Codex autonomous:** **Implemented** for the local dark-by-default route and fail-closed configuration; external activation and escalation policy require Tom.

### P1.5 — Expand health from connectivity to service readiness — PARTIALLY IMPLEMENTED 2026-08-24

- **Outcome:** The public `/api/health` route remains a fast dependency/deployment-identity probe. A separate authenticated administrator and platform-worker readiness projection now checks exact migration parity, worker-heartbeat freshness, explicit scheduler/provider-work mode, complete live observation of all canonical BullMQ queues, paused queues, and canonical long-running work. The Founder Control Room presents the same compact evidence and does not treat a green public probe as service readiness.
- **Evidence:** `packages/api/src/operations-readiness.ts`; `admin.operationsReadiness`; `/api/platform-worker/operations-readiness`; `OperationsReadinessSummary.tsx`; projection, HTTP, disposable integration, component, and accessibility tests.
- **Affected system:** Deployment, observability, incident response.
- **Remaining:** Provider execution, storage/ClamAV connectivity, email delivery, external uptime, SLO/threshold policy, and outbound alert delivery remain explicitly unproven. Add evidence-driven producers and alerts after the relevant external configuration/policy exists; do not synchronously call every provider from a health request.
- **Why it matters:** Operators and agents can now distinguish connectivity from core operational readiness without making unsupported external-provider claims.
- **Effort:** M
- **Dependencies:** External provider/configuration evidence and alert delivery for the retained gaps.
- **Before more venue acquisition:** **Yes**.
- **Codex autonomous:** **Implemented** for local code/tests and founder visibility; deployment alerts need configuration.

### P1.6 — Give clients a bounded insight and correction loop — IMPLEMENTED 2026-08-22

- **Outcome:** The client dashboard now shows a venue-scoped, privacy-bounded visitor pulse with aggregate activity, helpfulness, and content-review signals. Its correction action opens a prefilled service-led content-correction request; clients never receive raw conversation access or direct publication authority.
- **Evidence:** `portal.getVenueVisitorPulse`; `DashboardOverview.tsx`; `SupportWorkspace.tsx`; `(app)/support/page.tsx`; API, component, and route tests.
- **Affected system:** Client portal, analytics, content operations, support load.
- **Remaining work:** Calibrate useful trend depth and connect reviewed service requests into the existing operator/knowledge-proposal workflow where evidence warrants it; never direct-publish.
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
- **Current implementation:** An exact, read-only tenant/venue convergence measurement compares materialized guest-visible state with the active native deployment head under the venue content lock. A separate admin shadow comparison compares completed legacy and exact-native evaluation runs only when frozen corpus, case evidence, model, and prompt identities remain compatible; content and snapshot-wrapper configuration are the sole declared changes. It reports raw per-case quality, score, latency, cost, and missing-result deltas without inferring a pass threshold. The comparison now assembles a deterministic, non-executable per-venue read-switch contract that combines exact-head convergence with frozen shadow evidence, enumerates every remaining evidence/policy/runtime blocker, and retains the legacy compatibility path as the mandatory rollback target. A two-venue disposable cohort proves a nonzero native materialization and exact canonical revert while retaining the compatibility row and isolating the control venue. No surface switches reads, deletes compatibility data, or authorizes cutover.
- **Remaining gap:** Accumulate representative shadow evidence, establish founder-approved quality thresholds, implement a bounded read-switch executor, rehearse actual read-path rollback in a hosted disposable/staging fixture cohort, and retire compatibility paths only after the evidence and production gate are approved.
- **Why it matters:** Dual systems multiply defects, training burden, and migration risk.
- **Effort:** L
- **Dependencies:** Golden lifecycle, production content inventory, relevance tests.
- **Before more venue acquisition:** **Start before**, completion can be incremental.
- **Codex autonomous:** **Partly**; measurement, shadow evaluation, and contract assembly are autonomous, while executor enablement, production cutover, and compatibility retirement remain gated.

### P1.8 — Establish minimal lead-to-client continuity — IMPLEMENTED 2026-08-24

- **Outcome:** Torchiko now has platform-owned prospect organizations, venues, contacts, opportunities, stage and activity history, provenance, research/import state, correspondence, meetings, follow-up, reviewed outreach, durable customer relationships, and tenant-scoped location conversions. The prospect conversion is included in the retry-fenced `createClientAndVenue` server workflow and must be durably linked before that client-create intent can become complete; the browser no longer creates the customer and conversion through two independent mutations.
- **Evidence:** canonical prospect CRM schema and migrations; `prospect-actions.ts`; `client-management.ts`; `AdminCreateClientForm.tsx`; account context/history; API, dashboard, and disposable CRM tests.
- **Affected system:** Marketing, sales, onboarding, auditability.
- **Retained gates:** Real Gmail OAuth/Pub/Sub/watch renewal, sending activation, pricing, consequential promises, and customer communication remain externally or founder gated. Those do not erase the local lead-to-client continuity model.
- **Why it matters:** Prospect identity, relationship history, source evidence, and exact venue conversion now survive the handoff into onboarding.
- **Effort:** M
- **Dependencies:** External Gmail configuration for live correspondence; none for the local continuity model.
- **Before more venue acquisition:** **Recommended**, not blocking a few design partners.
- **Codex autonomous:** **Implemented** for local code/tests; external sending and customer commitments remain gated.

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

### P1.10 — Strengthen bounded citations into claim-level evidence — PARTIALLY RESOLVED 2026-08-25

- **Problem:** Guest chat now exposes deterministic provenance for explicitly named retrieved records, but that does not prove sentence-level semantic support.
- **Evidence:** `packages/api/src/lib/guest-citations.ts`; `packages/contracts/src/guest-answer-attribution.ts`; `packages/api/src/lib/guest-answer-evidence.ts`; `packages/api/src/routers/chat.ts`; `packages/db/src/helpers/guest-chat-turn-actions.ts`; `packages/db/src/helpers/guest-answer-attribution-actions.ts`; `docs/guest-answer-attribution.md`; `ResponseRenderer.tsx`; exact retrieved-record citation candidate evidence at `f142ef6e2a08a082ef46e8c00b9a582950c45870`.
- **Affected system:** Guest trust, knowledge provenance, quality evaluation.
- **Recommended change:** Use the implemented exact-evidence and claim-annotation contracts to build a representative human/provider-reviewed staging corpus. Measure evaluator agreement and claim segmentation before proposing any threshold. Continue describing the visitor feature narrowly as retrieved-record provenance.
- **Current implementation:** Newly generated public answers retain private, content-addressed answer/prompt/route/source evidence. A human platform administrator can record exact-span support judgments as append-only, evaluator-attributed history after every hash is reverified. Metrics are descriptive and contain no pass/release decision. A separately authorized, exact-venue MCP read exposes bounded completed reviews while the recording mutation remains human-only and unbound.
- **Remaining gap:** No automatic evaluator, calibrated corpus, evaluator-agreement evidence, approved quality threshold, release gate, or visitor-visible claim-level UX exists. Provider-backed staging calibration and product review remain required.
- **Why it matters:** Grounding is more valuable when visitors/operators can understand the source, especially for changing venue facts.
- **Effort:** M
- **Dependencies:** Provider-enabled staging, representative truth-set calibration, and human review; the claim-attribution contract is implemented locally.
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

- **Status (2026-08-24):** **Locally closed for five named synthetic journeys.** `pnpm test:visual-browser` now runs fifteen real-Chromium smokes at phone/tablet/desktop widths.
- **Evidence:** Guest route planning, the single-venue client portal, remote onboarding, the Founder Control Room shell, and an exact-scoped Internal Workspace now receive interaction, keyboard-focus, horizontal-overflow, console/page-error, browser axe (including contrast), and screenshot checks. The operator journeys verify exact active navigation; the mobile Founder shell additionally proves drawer operation, Escape dismissal, and focus restoration.
- **Affected system:** Public chat, onboarding, client/admin UI.
- **Recommended next change:** Retain separately authorized Clerk authentication, deployed-origin, real-device, screen-reader, zoom, and high-contrast evidence. The local fixtures exercise post-authentication production shells but do not bypass or claim Clerk authentication proof.
- **Why it matters:** The guest experience will often be mobile and embedded.
- **Effort:** M
- **Dependencies:** Stable fixture data and CI browser runtime.
- **Before more venue acquisition:** **No**, but before broad QR/widget deployment.
- **Codex autonomous:** **Yes**.

### P2.3 — Complete production answer-quality evaluation

- **Problem:** Eval infrastructure is strong, but current datasets/runs and automated hallucination/retrieval quality from real conversations were not observed.
- **Evidence:** evaluation models/contracts/worker/admin; low-confidence and explicit-negative-feedback insights; governed, human-sanitized conversation-to-evaluation-case preparation with immutable provenance; automatic regression alerts now fail dark unless an explicit durable policy supplies both alert and severity thresholds; current-live cases have a provider-dark lexical source-coverage preflight without an aggregate gate.
- **Affected system:** AI quality, reporting, operations.
- **Recommended change:** Continue expanding venue-specific golden questions, adversarial/out-of-scope cases, semantic/citation metrics beyond the bounded lexical preflight, provider-backed regression baselines, and human-review calibration. Sanitized production-failure sampling now has an operator workflow; it still needs staging corpus use and calibrated run history.
- **Why it matters:** Passing code tests does not prove truthful answers.
- **Effort:** L
- **Dependencies:** Golden venues, privacy policy, provider-enabled staging.
- **Before more venue acquisition:** **Begin now**; depth can grow later.
- **Codex autonomous:** **Partly**; humans must define truth and thresholds.

### P2.4 — Unify variable and human unit economics

- **Status (2026-08-24):** **FOUNDATION AND FOUNDER COVERAGE VIEW IMPLEMENTED.** A provider-neutral, append-only `OperatingCostEvidence` ledger now covers nine non-AI categories with platform/tenant/venue scope, observed/estimated/allocated evidence kinds, source references, quantities, exact periods, and uniquely fenced supersession. The Founder Control Room and machine operating view combine contained 30-day evidence with canonical AI estimates, show platform-unallocated cost, compare the prior window, and name missing coverage without inventing anomaly thresholds or prorating.
- **Retained gap:** Automated source ingestion, queue/media/storage counters, regular operator-time capture, accounting reconciliation, and a founder-set anomaly policy remain unimplemented. The view is not margin, invoice, pricing, or service-cutoff authority.
- **Problem:** AI usage is deeply instrumented, while storage, hosting, email, monitoring, file processing and operator time are not presented per tenant/venue.
- **Evidence:** `OperatingCostEvidence`; `recordOperatingCostEvidenceAction`; `admin.founderUnitEconomics`; Founder Control Room cost coverage; `pnpm test:operating-cost:disposable`.
- **Affected system:** Analytics, pricing, operations.
- **Recommended change:** Connect real provider exports and counters to the ledger, then add explicit policy-backed anomaly classification only after sufficient history and a founder threshold decision.
- **Why it matters:** AI optimization alone may target the wrong cost driver.
- **Effort:** M
- **Dependencies:** Pricing/cost-source policy.
- **Before more venue acquisition:** **No** for ten venues; useful before one hundred.
- **Codex autonomous:** **Partly**.

### P2.5 — Turn agent outcomes into a reviewed improvement loop

- **Status (2026-08-23):** **VALIDATION EVIDENCE IMPLEMENTED.** Exact venue/identity/task-class outcome sets can become immutable, versioned `AgentImprovementProposal` hypotheses. After human approval, an authorized quality worker or platform admin can append an immutable implementation reference and a same-corpus before/after `EvalRun` comparison. Only explicitly declared content, model, or configuration changes may differ; corpus or evidence drift is always incomparable. Approval and validation change neither behavior nor authority.
- **Retained gap:** Applying the proposed change remains separate Codex/admin work. No runtime consumer rewrites prompts, changes routing/models, promotes permissions, or interprets a comparison as an automatic promotion threshold.
- **Evidence:** `AgentImprovementValidationEvidence`; `recordAgentImprovementValidationAction`; `torchiko.agent_improvements.record_validation`; `pathfinder.agent-improvements`; `pnpm test:agent-improvement:disposable`.
- **Affected system:** Agents, evaluations, model routing.
- **Recommended next change:** Accumulate real comparable runs and define any promotion policy only with founder review.
- **Why it matters:** This makes “improvement” measurable without unsafe self-modification.
- **Effort:** M
- **Dependencies:** Enough real runs and outcome labels.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Partly**; promotion policy requires approval.

### P2.6 — Pin local infrastructure images and clarify Railway ownership

- **Status:** **LOCAL IMAGE REPRODUCIBILITY RESOLVED 2026-08-25; HOSTED CONFIGURATION OWNERSHIP REMAINS.** Every PostgreSQL/pgvector, Redis, MinIO, MinIO client, and ClamAV image in the provider-dark local-staging stack is bound to an exact repository digest. A static test rejects any unpinned dependency, and the upgrade runbook requires compatibility review plus local/disposable proof.
- **Remaining problem:** Root Railway/Nixpacks and per-service Docker configurations coexist. Their hosted ownership cannot be inferred from local compose behavior.
- **Evidence:** `compose.local-staging.yml`; `scripts/local-staging-worker.test.mjs`; `docs/local-staging-infrastructure.md`; Railway configs and staging verifier.
- **Affected system:** Developer experience, deployment reproducibility.
- **Recommended change:** During an authorized hosted staging integration, prove which service configuration Railway actually consumes, designate those files canonical, and retire or explicitly mark only genuinely superseded configuration.
- **Why it matters:** Builds and local behavior should not change because an upstream tag moved.
- **Effort:** S
- **Dependencies:** Tested compatible versions and deployment confirmation.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Local pinning implemented**; hosted configuration removal requires confirmation.

### P2.7 — Improve repository onboarding and doc discoverability

- **Status:** **LOCALLY RESOLVED 2026-08-24.** The README now routes directly to a concise safe onboarding guide covering install, deterministic verification, provider-dark local staging, release/handoff, current-truth precedence, and debugging. A generated command/configuration index inventories every root command and documented environment name without retaining values; the static release profile fails closed when it drifts.
- **Historical problem:** The README identified workspaces but omitted the full install/env/migrate/local-staging/debug path; historical packet docs could outrank current truth.
- **Evidence:** `README.md`; `docs/repository-onboarding.md`; generated `docs/repository-command-index.md`; generator and deterministic/redaction tests; `repository-onboarding` release gate.
- **Affected system:** Developer/agent experience.
- **Remaining maintenance:** Keep the current-truth map authoritative and update focused operator guides when workflow ownership changes; do not mechanically relabel historical evidence as current.
- **Why it matters:** Future sessions repeatedly spend time rediscovering the same boundaries.
- **Effort:** S
- **Dependencies:** None.
- **Before more venue acquisition:** **No**.
- **Codex autonomous:** **Yes**.

### P2.8 — Remove the remaining UI/build warnings

- **Status:** **LOCALLY RESOLVED 2026-08-24** for the actionable application warnings. The venue-photo `<img>` is now an explicit security-boundary exception, and both Next applications externalize the Sentry/OpenTelemetry instrumentation chain while preserving those packages in standalone output. Focused production builds complete without the raw-image lint warning, `Critical dependency`, `require-in-the-middle`, or `Compiled with warnings` output.
- **Historical problem:** Lint warned on raw `<img>`; Next builds warned on Sentry/OpenTelemetry dynamic requires and Windows standalone link names.
- **Evidence:** `apps/web/components/PlaceCard.tsx`; both `next.config.ts` files; focused web/dashboard lint and production builds; standalone-package trace inspection.
- **Affected system:** Web performance, build signal quality.
- **Remaining deployment proof:** Exercise the generated standalone artifacts on the actual Linux staging path. Windows-specific standalone-link behavior is not treated as Linux deployment evidence.
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

| Idea to park                               | Why not now                                                                                                                           | Revisit trigger                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Autonomous sales/support email sequences   | No CRM, deliverability controls, approval policy, or general mail domain exists.                                                      | Stable lead records, approved templates, domain health, event delivery and human override.    |
| Self-modifying agent prompts/models        | Outcome data is sparse and no safe promotion/eval loop exists.                                                                        | Statistically useful labeled outcomes and versioned approval workflow.                        |
| Full indoor turn-by-turn navigation        | Location V1 resolves verified anchors and now has guarded anchor authoring, but floor/connection authoring and routing remain absent. | Multiple customers explicitly pay for routing and supply reliable map data.                   |
| Build a custom subscription/billing engine | Entitlements are still changing and no payment provider is selected.                                                                  | Validated pricing and need beyond a hosted billing provider.                                  |
| Rewrite the admin UI/design system         | Existing surfaces are coherent and accessible; operational proof is more valuable.                                                    | Measured task failures, not aesthetic preference.                                             |
| Replace BullMQ/Prisma/Next/Clerk           | Current foundations are functioning and heavily tested.                                                                               | Demonstrated scalability, security, or vendor constraint that cannot be solved incrementally. |
| Broad consumer Torchiko network            | No validated venue cohort or shared-place rights model yet.                                                                           | Repeatable venue operations and clear consumer acquisition loop.                              |
