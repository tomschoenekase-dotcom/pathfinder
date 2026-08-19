# Torchiko AI-native company alignment report

**Status:** evidence-backed current-state review
**Reviewed:** 2026-08-18
**North star:** [`TORCHIKO_AI_NATIVE_COMPANY_NORTH_STAR.md`](./TORCHIKO_AI_NATIVE_COMPANY_NORTH_STAR.md)

## Executive assessment

Torchiko is not starting from zero and should not be rewritten. Its present implementation already contains a strong, safety-oriented agent control-plane foundation: durable agent identities and runs, append-only evidence, separate questions and approvals, automatic run redispatch after human answers, bounded execution leases, provider/model assignment, cost accounting, specialist delegation, and an authenticated desktop bridge for Hermes, Codex, Claude, and local OpenAI-compatible runtimes.

The north-star split is technically viable with the current primitives:

- **Hermes** can remain the persistent workforce runtime through the existing Hermes bridge and named-profile adapter.
- **Torchiko** already owns operational scope, durable work, permissions, approvals, costs, artifacts, and audit evidence.
- **Obsidian** now has a controlled, review-first knowledge-promotion protocol and AI Knowledge Inbox. Torchiko deliberately has no arbitrary automated vault writer; that boundary should remain until promotion quality and governance are proven.

The strongest next move is to connect and consolidate the existing foundations. A rewrite, a second agent runtime inside Torchiko, or a burst of unmeasured specialist creation would reduce reliability.

## Gap map

| Area                                 | Status                                        | Evidence in the current implementation                                                                                                                                                                                                                                                | Recommended direction                                                                                                                                                                                         |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI Operations                        | **IMPLEMENTED FOUNDATION / PARTIAL FLAGSHIP** | The global Operations console now puts Needs You first and separates Working Now, Blocked/Problems, Completed, and Outcome Signals. Venue workspaces retain task creation, identities, integrations, approvals, conversations, artifacts, lineage, cost, cancellation, and timelines. | Add a team/performance projection after enough outcome evidence exists, then incremental refresh and polished loading behavior. Preserve bounded metadata reads and run-detail evidence.                      |
| Questions and approvals              | **STRONG**                                    | `AgentQuestion` and `ApprovalRequest` are distinct durable models. Questions use optimistic concurrency; approvals remain separate authority.                                                                                                                                         | Preserve separation. Add richer optional decision context only after usage shows which fields matter.                                                                                                         |
| Human answer → resume                | **STRONG**                                    | Answering a blocking question transitions `AWAITING_INPUT` to `QUEUED` and idempotently enqueues the run when the runtime flag is enabled.                                                                                                                                            | Preserve and add deployed end-to-end monitoring. Do not make an answer imply approval.                                                                                                                        |
| Agent run model                      | **STRONG**                                    | Durable status, parent/child delegation, retries, lease tokens, heartbeats, cancellation intent, bounded attempts, artifacts, messages, costs, and append-only timeline evidence exist.                                                                                               | Preserve. Add explicit outcome/review records rather than overloading terminal status.                                                                                                                        |
| Agent identity                       | **STRONG / PARTIAL**                          | Logical identity is separate from provider/model and includes role, scope, capabilities, autonomy, provider, model, enablement, and history through runs.                                                                                                                             | Preserve identity portability. Add measured strengths/weaknesses later from outcome data, not free-form claims.                                                                                               |
| Hermes integration                   | **PARTIAL**                                   | Authenticated bridge sessions and a named-profile Hermes ACP adapter exist; Hermes permission requests are deny-by-default.                                                                                                                                                           | Keep Hermes as runtime. Define reviewed role-specific permission maps and prove a retained Hermes task before expanding autonomy.                                                                             |
| Codex / Claude integration           | **PARTIAL**                                   | Desktop bridge adapters exist for read-only Codex subscription work and plan-only Claude subscription work.                                                                                                                                                                           | Keep them as external engineering runtimes. Expand permissions only through explicit, auditable profiles.                                                                                                     |
| MCP architecture                     | **PARTIAL / strong boundary**                 | Fourteen bounded resource families—including explicit outcome evidence—and seven tools exist with verified scope, capability, risk, approval, strict schemas, and injected domain actions.                                                                                            | Add business capabilities incrementally through canonical domain actions. Avoid a generic “do anything” mutation tool. Add Torchiko aliases/versioning rather than breaking `pathfinder.*` clients.           |
| Kanban integration                   | **DUPLICATIVE RISK / DEFER pending proof**    | Torchiko already has durable AgentRun work; Hermes Kanban exists outside this repo but its unattended lifecycle is not yet approved.                                                                                                                                                  | Do not rebuild Hermes Kanban. Define synchronization/lineage only after the retained Hermes Kanban smoke reaches `done` without manual steering.                                                              |
| Obsidian read                        | **MISSING in Torchiko repo**                  | No application or MCP binding to the Tom OS vault was found. Hermes can access the local vault independently.                                                                                                                                                                         | Treat Obsidian as an external organizational knowledge service. Start with a controlled protocol and review inbox, not arbitrary writes.                                                                      |
| Obsidian write / knowledge promotion | **IMPLEMENTED FOUNDATION**                    | Tom OS now has an active promotion protocol, a property-compatible candidate template, and a review-only AI Knowledge Inbox. Torchiko still has no automated vault writer.                                                                                                            | Exercise the human-reviewed flow first. Add machine writes only after paths, schemas, provenance, dedupe, contradiction handling, and review behavior are proven.                                             |
| Private agent memory                 | **MISSING / Hermes-owned**                    | Torchiko stores prompts, messages, results, and history, but no private memory policy.                                                                                                                                                                                                | Keep private memory in Hermes. Torchiko should retain business evidence and feedback, not duplicate runtime memory.                                                                                           |
| Outcome feedback                     | **IMPLEMENTED FOUNDATION**                    | `AgentOutcomeObservation` records append-only, idempotent human review evidence against a terminal run with frozen agent, task-class, provider, and model identity. QA/evaluation, support, analytics, and job outcomes still require explicit adapters.                              | Exercise human reviews first, then add narrow adapters for proven domain outcomes. Add workflow/skill version identity before using outcomes for routing.                                                     |
| Agent reputation/performance         | **MISSING / correctly premature**             | Run counts, costs, status, and raw evidence exist; no acceptance/correction/quality rollup exists.                                                                                                                                                                                    | Defer scoring until outcome labels exist. Never infer quality from completion alone.                                                                                                                          |
| Operational audit trail              | **STRONG**                                    | Strict audit logging, immutable history in several domains, agent action/timeline evidence, approval lineage, credential receipts, and lease fencing exist.                                                                                                                           | Preserve. Add a company-level activity projection that lazy-loads deep evidence.                                                                                                                              |
| Email agent architecture             | **EARLY**                                     | A durable BullMQ/Resend welcome-email path exists. No general inbox classification, drafting, approval, CRM linkage, or safe send policy exists.                                                                                                                                      | Build a provider-neutral email domain and reviewed draft/queue/send transitions before exposing agent send tools. Do not let MCP call Resend directly.                                                        |
| Client portal question workflows     | **PARTIAL**                                   | Portal, support request, participant, message, missing-information, and manual question flows exist. AgentQuestion currently targets the platform operator, not a client participant.                                                                                                 | Reuse support/participant primitives for customer questions; add explicit recipient, response, and automatic-resume linkage rather than a parallel portal inbox.                                              |
| Onboarding architecture              | **PARTIAL / substantial**                     | Intake runs, evidence, uploads, handoffs, media ingestion, missing-information questions, packages, deployment review, and evaluation exist.                                                                                                                                          | Preserve. A separate remote-onboarding packet should drive deeper work. Only ensure new agent/event interfaces can attach to these states.                                                                    |
| QA/testing infrastructure            | **STRONG foundation**                         | Evaluation runs, frozen inputs, results, cost reservations, comparison, cancellation, QA evidence, and broad unit/integration coverage exist.                                                                                                                                         | Connect evaluation outcomes to agent/model/workflow decisions. Do not claim autonomous repair until safe repair actions and rollback are proven.                                                              |
| Event architecture                   | **PARTIAL**                                   | Analytics event emission and durable BullMQ queues exist; several domain lifecycles enqueue work directly. There is no general versioned business-event contract for agent triggers.                                                                                                  | Introduce a narrow outbox/event envelope for selected high-value triggers. Do not create an unbounded event bus first.                                                                                        |
| Model/provider configuration         | **PARTIAL / strong foundation**               | Central model registry, staged global/client/venue overrides, fixed-point pricing, provider/model fields on identities, bridge provider registry, and fallback metadata exist.                                                                                                        | Remove remaining provider strings from feature code over time. Add logical task classes and evaluation-based routing; retain reversible overrides.                                                            |
| Cost tracking                        | **STRONG foundation**                         | `AiUsageEvent`, daily rollups, budgets, reservations, fixed-point cost helpers, per-run/action costs, and model price versions exist.                                                                                                                                                 | Build outcome-normalized views after agent outcomes exist. Estimates must remain visibly distinct from invoices.                                                                                              |
| Model economy automation             | **MISSING / DEFER**                           | No hourly market watcher or automatic canary router exists. Evaluation infrastructure and central registry are useful prerequisites.                                                                                                                                                  | Defer autonomous switching. First add candidate records, benchmark suites, policy tiers, canary comparison, rollback, and expiration metadata. External price checks require an approved network/data source. |
| Agent permissions                    | **STRONG foundation / narrow**                | Closed capability/action enums, coherence checks, access scopes, autonomy levels, approval requirements, venue-scoped machine credentials, and deny-by-default Hermes ACP exist.                                                                                                      | Expand capability vocabulary only alongside canonical action tests and audit evidence. Keep high-risk actions approval-gated.                                                                                 |
| Frontend performance                 | **PARTIAL**                                   | Company and venue projections are cursor-bounded; deep details and raw traces are separate. The server-oriented page still lacks incremental refresh and polished skeleton behavior.                                                                                                  | Add incremental refresh and skeletons only after measuring the deployed query and render path. Keep large traces lazy.                                                                                        |
| AI Operations UX                     | **IMPLEMENTED FOUNDATION / PARTIAL**          | The global information architecture now prioritizes Needs You, Working Now, Blocked/Problems, Completed, and Outcome Signals with exact drill-downs. Team performance and activity remain early.                                                                                      | Add team strengths/weaknesses only from validated outcome data; continue visual/performance iteration without moving configuration back into the primary judgment flow.                                       |

## What should be preserved

1. The separation of questions from approvals.
2. Torchiko-owned operational state, scope, audit evidence, costs, and permission enforcement.
3. Hermes-owned persistent identities, skills, memory, and runtime behavior.
4. Logical agent identity independent of provider/model.
5. Revocable venue-scoped machine credentials and the rule that Torchiko stores no subscription/browser credentials.
6. Durable leases, cancellation observation, bounded attempts, idempotency, and stale-worker fencing.
7. Canonical domain actions behind MCP instead of direct database or provider access.
8. The existing intake, support, evaluation, package, and content lifecycle primitives.
9. Default-dark feature flags and deny-by-default external execution.

## What should be extended now

1. Exercise the new Obsidian knowledge-promotion protocol with reviewed candidates before authorizing any automated writer.
2. Exercise the new agent outcome evidence against real reviewed terminal runs before deriving scores or routing policy.
3. Measure the expanded company-level AI Operations projection under representative activity volume before adding polling or streaming.
4. Add role-specific Hermes permission maps only with a retained end-to-end smoke test.
5. Add versioned event/outbox contracts for a small number of valuable agent triggers.
6. Add provider-neutral email draft/queue/send domain boundaries before agent-operated email.
7. Add richer customer-question linkage through existing support/portal participants.

## What should be deferred

- Full remote onboarding design, which has a separate future packet.
- Agent reputation scores until enough outcome labels exist.
- Hourly model-market automation until trusted price sources, internal evaluations, canaries, and rollback are implemented.
- Automatic high-risk model switching.
- Broad customer-facing autonomy, refunds, billing, contracts, production deployment, and destructive actions.
- A second Kanban/runtime inside Torchiko.
- A large catalog of persistent specialists without observed recurring workloads.
- Decorative dashboards for metrics that do not yet have trustworthy data.

## Major architectural risks

1. **Control-plane/runtime blur.** Putting Hermes memory or orchestration internals into Torchiko would create two competing runtimes.
2. **Operational-state drift.** Allowing Hermes or Obsidian to become authoritative for clients, approvals, support, or onboarding would split business truth.
3. **False quality metrics.** Completion rate without reviewed outcomes rewards fast failure and agent theater.
4. **Permission expansion by convenience.** A generic mutation tool would bypass the strong closed-capability design.
5. **UI accumulation.** Adding every trace and configuration to one page would make AI Operations slower and less useful for judgment.
6. **Provider coupling.** The central registry is sound, but current Anthropic-only API specs and exact model coherence checks need gradual abstraction.
7. **Uncontrolled vault writes.** Direct bot writes without promotion/deduplication would pollute organizational knowledge.
8. **Premature automation.** Automatic model switching, task generation, or customer email without measurable outcomes and rollback would increase hidden operational risk.
9. **Legacy naming drift.** `PathFinder` remains in packages, MCP tool names, assets, and docs. A sudden rename would break contracts; use an explicit compatibility/migration plan.

## Recommended phases

### Phase 0 — preserve and prove

- Keep the existing runtime and safety boundaries.
- Maintain full local verification and disposable-database migration proof.
- Deploy no external integration without environment-specific authorization.
- Prove retained Hermes/Kanban behavior before making it load-bearing.

### Phase 1 — trustworthy organizational loop

- **Implemented foundation:** establish the Obsidian knowledge inbox and promotion policy.
- **Implemented foundation:** add structured agent outcome/review evidence.
- **Implemented foundation:** build company-level AI Operations read projections from existing durable state.
- Improve blocked/attention/resume observability.
- Define a first narrow business-event envelope and outbox.

### Phase 2 — useful business operation

- Add reviewed MCP actions for CRM/support/content through canonical domain services.
- Add client-directed questions and automatic workflow resume.
- Build provider-neutral email draft, approval, queue, send, and outcome tracking.
- Connect QA and support outcomes to agent/model/workflow performance.

### Phase 3 — measured delegation and routing

- Add capability, availability, historical outcome, cost, and latency signals to specialist selection.
- Add internal Torchiko evaluation suites by task class.
- Introduce candidate model records and canary comparison with manual rollback.

### Phase 4 — bounded autonomy

- Promote proven low-risk workflows up the autonomy ladder.
- Add policy-based low-risk model switching.
- Add recurring opportunity detection with budgets, deduplication, and escalation limits.
- Expose cost per successful outcome and repeated-human-intervention metrics.

## Immediate implementation decision

The first authorized foundational change is now complete: the knowledge-promotion boundary produces reviewable proposals only and grants no arbitrary vault-write authority to agents.

The second foundational change is now complete: agent outcome evidence has a scoped write action, read projection, run-detail review control, audit/timeline evidence, immutable database guards, and focused tests. Reputation, automated routing, and model-economy behavior remain downstream so the system cannot optimize against completion theater.

The third foundational change is now complete: the existing global Operations console—not a duplicate dashboard—provides the north-star attention/work/outcome grouping through bounded metadata projections, and the MCP read catalog exposes explicit outcome observations without operation IDs or human actor identifiers.

## Verification evidence

- `pnpm typecheck`: passed across all 23 tasks.
- `pnpm lint`: passed across all 13 lint tasks; the only warning is the existing raw-image warning in `apps/web/components/PlaceCard.tsx`.
- `pnpm test`: passed across the workspace, including 146 script tests passing and one intentional skip.
- A fresh loopback-only pgvector PostgreSQL container applied all 99 migrations from zero. The final schema contained all seven outcome-observation indexes and the insert, append-only mutation, and no-truncate guards. The exact disposable container was removed afterward and Docker Desktop was stopped.
- Focused outcome tests cover terminal-run enforcement, tenant/scope enforcement, idempotent replay, audit/timeline evidence, API reads/writes, and the run-detail review form.
- Focused AI Operations tests cover grouped Needs You, Working Now, Blocked/Problems, Completed, and empty-state behavior.
- Focused MCP tests prove the fourteenth resource is capability-gated and does not expose operation IDs or human actor identifiers.
- `git diff --check`: passed; line-ending notices are informational and no whitespace error was reported.

## Completion boundary

This review does not claim the long-term north star is “finished”; several sections explicitly describe future systems that need real production data, separate authorization, or a dedicated implementation packet. The current authorized implementation is complete when the preserved architecture, gap map, three high-confidence foundations, and their verification evidence are handed off. Remaining work is phased and intentionally not converted into speculative autonomous behavior.
