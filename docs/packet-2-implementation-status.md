# PathFinder Packet 2 implementation status

Last updated: 2026-08-11

Authoritative product target: `C:\Users\tomsc\Downloads\AwesomeVault\00 Inbox\2026-08-11 1430 Capture.md`.
Packet 2 supersedes earlier feature packets and planning notes where they conflict. Earlier documents
remain useful only as evidence about the starting state.

## Non-negotiable operating boundaries

- The external database incident stop in `docs/database-incident-stop.md` remains active.
- No external database inspection, migration, seed, rollback, or remediation is authorized.
- Code, contracts, forward-only migration files, static verification, and exact-name disposable
  loopback verification may continue within the documented guard.
- No public API, SDK, payment activation, production promotion, destructive retention enforcement,
  or permanent external commitment occurs without the owner decision required by Packet 2.
- Existing guest links, QR destinations, widgets, identifiers, tenant isolation, audit history, and
  reversible package behavior remain compatibility constraints.

## Implemented in the current Packet 2 worktree

### Product architecture foundations

- Shared design-system primitives for buttons, status, surfaces, empty states, and accessible form
  controls in `packages/ui`.
- Typed, independently modeled venue archetypes, presets, capabilities, feature flags, audiences,
  and configuration provenance contracts in `packages/contracts`.
- Versioned client-facing tone presets with internal behavior mappings that cannot override system
  or safety controls, persisted through venue updates, packages, history, and guest prompt context
  with legacy compatibility.
- Granular typed content-module contracts for places, items, knowledge, services, policies, events,
  operational facts, and relationships. Each record carries its own venue scope, version, audience,
  and evidence references.
- Additive normalized persistence for services, policies, events, operational facts, and
  relationships uses payload-free identities, immutable revision envelopes, separate typed payload
  tables, and append-only evidence. Exact tenant/venue/kind/endpoint constraints prevent drift;
  existing Place and Knowledge data remains untouched behind compatibility paths.
- Structured support-workflow contracts plus tenant/venue-scoped request, immutable message,
  attachment metadata, and append-only audit persistence. Client APIs cannot read or create internal
  notes; admin APIs use explicit scope, pagination, and version-CAS message mutations. Package/apply
  orchestration remains separate and unimplemented.
- Support creation and message append are the first canonical domain actions shared below route
  adapters. They require trusted HUMAN/AGENT/SYSTEM actor context, enforce visibility and scope,
  and transactionally couple version CAS, content evidence, support audit, and platform audit.
- Shared intake contracts for every packet source type, bounded draft-only website intake,
  evidence/discrepancy records, and the complete orchestration stage sequence.
- Server-side website adapter with exact-host allowlists, credentialed-URL rejection, DNS/IP and
  redirect revalidation, private/link-local/metadata address blocking, robots policy injection,
  page/depth/byte/time bounds, deterministic dedupe/cost/job evidence, citations, date-sensitive
  discrepancies, and draft-only package handoff. It has no live fetch binding or route.
- Neutral `@pathfinder/intake-engine` package reusable by workers and API with injected adapters,
  deterministic dedupe/run/draft/events, contradiction preservation, cancellation, time/source/
  evidence/discrepancy/cost bounds, and validated draft-for-review handoff. Unconfigured source
  types fail explicitly rather than pretending extraction; there is no approve/apply/publish API.
- Text-only staff-interview adapter supplies five role-specific question sets, consent, privacy
  classification, skip/redact/uncertainty handling, deterministic evidence, and monotonic audience
  protection. Recording/audio/video fields are structurally rejected pending owner privacy policy.
- Browser-safe Venue Deployment Manifest v2 contracts support FULL and granular PATCH packages with
  identity, branding/assets, versioned AI/tone/model references, effective configuration provenance,
  typed content/evidence, readiness/evaluation, immutable hashes, base hash, and idempotency. Patch
  operations use stable-ID upsert/retire/reset; tenant authority, secrets, binaries, unsafe URLs, and
  monolithic content replacement are rejected. Persistence/apply/rollback adapters remain pending.
- Offboarding contracts require evidence-backed revocation of guest links, widgets, API/MCP access,
  jobs, agents, client access, and impersonation plus export manifests. They explicitly cannot
  authorize deletion while retention policy remains owner/legal gated.
- Tenant-scoped offboarding plan, venue-target, revocation-evidence, and export-artifact persistence
  is defined in a forward-only migration with append-only and delete guards. Admin APIs may only
  list/get/create a REQUESTED plan; no revocation, completion, retention, or deletion action exists.
- Client-scoped internal Offboarding console displays venue targets, all required revocations,
  append-only evidence, and export metadata. Operators may only create a confirmed REQUESTED draft;
  the UI prominently states that retention is unresolved and exposes no execution/deletion control.
- AA-aware guest accent/text contrast selection and reduced-motion-safe reveal behavior.

### PathFinder OS

- Responsive internal OS shell with persistent, grouped navigation.
- Global Cmd/Ctrl-K client lookup backed by authorized, server-filtered bounded admin data.
- Attention-first command center replacing the prohibited endless-directory homepage.
- Operational exception triage for AI incident state, failed jobs, suspended clients, and setup
  accounts.
- Recent work, operational status, compact recent operations, a separate client directory, and a
  dedicated operations view. The directory now uses server search and stable cursor pagination;
  the legacy all-client procedure is compatibility-bounded.

### Client and guest surfaces

- Ultra-Simple Client Portal reconstruction: no analytics, responsive calm navigation, lifecycle
  status, single-venue-first home, unobtrusive multi-venue switching, operational updates, simple
  tone controls, real venue-scoped support requests/replies with conflict-safe draft retention, and
  platform-admin-only links back to internal tools.
- Premium onboarding reframed around modest raw client input, private assembly milestones, and
  preview rather than asking clients to design the knowledge system themselves.
- Guest structured response renderer foundation with backward-compatible text/place responses plus
  callouts, safe actions, citations, and typed place collections.
- Route-level loading states and reduced-motion-safe transitions across the rebuilt surfaces.

### Internal operations and agent foundations

- Scope-aware Internal Client Workspace with client/venue breadcrumbs, grouped workflows, venue
  switching, readiness warnings, guest preview, and advanced controls separated from client UI.
- Admin-only Universal Content explorer groups typed modules and shows version, audience, effective
  state, and provenance summaries with strict venue scope and cursor pagination. Places/Knowledge
  remain explicitly labeled compatibility systems; no client/guest exposure or mutation exists.
- Agent identity, run, action, access/autonomy, timeline, and reusable approval persistence
  primitives with append-only and cross-scope migration guards.
- Canonical approval-decision action requires a human platform admin, exact tenant/venue/request,
  pending and unexpired state, single-decision conflict handling, and strict audit in one
  transaction. The admin form records evidence only and explicitly cannot execute proposed work.
- Tenant/venue-scoped, paginated admin read APIs for agent identities, runs, actions, timelines, and
  approvals; raw action payloads and artifacts are intentionally excluded.
- Read-only venue Agent Operations views separating access scope from autonomy and exposing runs,
  lifecycle timelines, action/version summaries, fixed-point cost, and approval state without
  enable/run/retry/cancel/approve controls.
- Read-only Evaluation Operations API and venue console separating operational failures from scored
  quality outcomes and showing frozen model, prompt, content, package, and corpus identities plus
  bounded human conclusions.
- Versioned canonical venue-content snapshot hashing covers exact guest-facing venue, place,
  knowledge, current operational-update, prompt/config, and latest effective PUBLIC universal
  content fields with stable ordering and NFC. Internal audiences, provenance metadata, embeddings,
  and audit timestamps are excluded from the content identity.
- Default-off evaluation admission freezes server-derived case/model/prompt/content identities,
  enforces 1–50 cases and a $1 request ceiling, and enqueues through a bounded runner that separates
  quality outcomes, operational failure, budget block, cancellation, and retry evidence. The worker
  remains intentionally unregistered until enabled and infrastructure-verified.
- Read-only Freshness Audit queues for overdue human-reviewed sources, provenance metadata gaps, and
  expired/soon-expiring operational updates. The console never represents metadata gaps as factual
  contradictions and exposes no patch/publish action.
- Internal Support Operations console separates client-visible replies from internal notes, exposes
  append-only request evidence, and limits operator mutation to conflict-safe messages/notes.
- Default-off flags for richer guest components, generalized capabilities, onboarding automation,
  autonomous support actions, MCP writes, partner API, and SDK release.
- MCP v0 contracts and a transport-neutral adapter registry targeting official protocol revision
  2026-07-28: 12 scoped resources, read/draft/bounded-evaluation tools, strict structured results,
  verified credential context, injected canonical domain actions, default-off writes, and exact
  approval/scope/capability checks. Transport, OAuth, credentials, rate limiting, and live bindings
  remain intentionally unimplemented and dark.
- Dark Partner Read API v1 contracts and registry for six bounded operations. Availability requires
  the exact default-off flag plus injected revocation, expiry, rate-limit, audit, scope, and canonical
  read dependencies; there is no listener, key persistence, live binding, SDK, or public launch.

### Additional foundations completed locally

- A neutral, worker-safe Intake Engine now provides deterministic source deduplication, bounded
  orchestration, evidence and discrepancy reconciliation, cancellation and cost limits, and a
  draft-for-review-only handoff. The website adapter is concrete and SSRF/redirect/DNS bounded;
  staff interviews are consent-gated and text-only. Other source adapters report
  `NOT_CONFIGURED` instead of pretending to ingest.
- Universal normalized content persistence is additive and typed: payload-free identities,
  immutable revision envelopes, separate Service, Policy, Event, Operational Fact, and
  Relationship payloads, and append-only evidence. Exact tenant/venue/kind constraints prevent a
  generic lowest-common-denominator content table.
- Venue Deployment Manifest v2 contracts support complete and granular patch manifests with
  stable-ID operations, effective configuration provenance, immutable asset references,
  evaluation/readiness evidence, canonical hashing, and deterministic diffing. The existing
  package v1-v3 lifecycle remains the persisted compatibility path until a reviewed adapter is
  built.
- Offboarding persistence and the operator console can create and inspect requested plans,
  revocation targets, evidence, and export metadata. Execution and deletion remain absent by
  design pending authorization and retention policy.
- Evaluation enqueue and runner foundations are implemented with frozen identities, case and
  budget caps, cancellation, retry-aware terminal evidence, and separate quality/operational
  outcomes. Admission is default-off and the worker is deliberately not registered for live
  execution.

## Required program work not yet proven complete

- Remaining Internal Client Workspace deep capability views and domain-action adapters.
- Durable intake source/evidence/proposal persistence and adapters beyond website and text-only
  staff interviews, plus the final onboarding-to-draft bridge.
- Venue Deployment Manifest v2 persistence and reviewed adapters into the existing
  preview/approve/apply/rollback lifecycle.
- Broader canonical domain action coverage beyond support and approval decisions, so every UI,
  worker, API, MCP, and agent mutation shares the same services.
- Support request-to-package orchestration beyond the contract and persistence foundation.
- Agent action adapters and protected enable/run/retry/cancel/approval mutations.
- MCP transport/authentication and live domain bindings, partner credential lifecycle, and any
  staging-justified thin SDK.
- Live evaluation worker registration/provider execution, reports lifecycle redesign, and
  authorized offboarding execution.
- Remaining table pagination/batching/virtualization work and measured browser performance
  evidence. Admin client lookup/directory and portal eager analytics/report fetches are already
  corrected.
- Full desktop/mobile visual QA, browser E2E, accessibility automation, and migration rehearsals.
- Isolated live staging, alert delivery, promotion, restore, and production evidence where owner
  authorization is required.

## Final local verification — 2026-08-11

- `pnpm typecheck`: 23 tasks passed across 13 workspaces.
- `pnpm lint`: 13 workspace tasks passed; one existing arbitrary external guest-image warning
  remains and no lint errors were reported.
- `pnpm test`: all 13 workspace suites passed; structural/security scripts passed 135 tests with
  one intentional legacy-package fixture skipped.
- `pnpm build`: all 13 workspace builds passed, including optimized dashboard and guest Next.js
  builds. Next/Sentry emitted the existing OpenTelemetry dynamic-require warning and Windows
  standalone symlink-name warnings.
- Static security boundaries passed: 734-source AI provider review, 12 budgeted gateway call sites,
  62 exact raw-SQL operations, 120 reviewed tenant bypasses in 37 files, 62 generated cross-tenant
  procedures, 64-model tenant registry, Docker boundary, public-surface inventory, and browser
  bundle scan across 286 deliverable files with 11 environment/credential canaries.
- Formatting was applied only to packet-owned changed/new files. `git diff --check` passes.
- No database, Redis, provider, migration-apply, staging, or production operation was executed.

Live browser visual/E2E evidence is not claimed: the in-app browser had no connected runtime, and
starting a data-backed application against an unidentified environment would violate the active
database incident stop.

## Completion evidence policy

Packet 2 is complete only after every explicit section is mapped to authoritative code, tests,
rendered/browser behavior, operational evidence, or an owner-only decision. A passing typecheck or a
finished local slice is not evidence of live readiness. Code-complete and live-verified states must
remain distinct.
