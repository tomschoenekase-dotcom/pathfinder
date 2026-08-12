# PathFinder Packet 2 implementation status

Last updated: 2026-08-11

Authoritative product target: `C:\Users\tomsc\Downloads\AwesomeVault\00 Inbox\2026-08-11 1430 Capture.md`.
Packet 2 supersedes earlier feature packets and planning notes where they conflict. Earlier documents
remain useful only as evidence about the starting state.

Section-level evidence and blockers are indexed in
`docs/packet-2-traceability-matrix.md`. That matrix is the authoritative continuation ledger for all
69 packet sections; neither this summary nor a passing local suite constitutes a completion claim.

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
  existing Place and Knowledge data remains the compatibility store, now reached through canonical
  create/update/soft-retire actions with exact scope, locking, `updatedAt` CAS, content-version
  context, and strict transactional audit.
- Structured support-workflow contracts plus tenant/venue-scoped request, immutable message,
  attachment metadata, and append-only audit persistence. Client APIs cannot read or create internal
  notes; admin APIs use explicit scope, pagination, and version-CAS message mutations.
- Client Support authorization is now an immutable requester plus explicit active-participant ACL.
  `STAFF`, `MANAGER`, and `OWNER` have equal requester-or-participant access and no implicit role-wide
  visibility; requester and participant membership must remain active. Requester-only, actor-bound
  grant/revoke actions retain append-only evidence and use `clientVersion` CAS. Client-safe
  projections expose only current-user booleans and `Your team` UI copy, not member identities.
  Platform-admin Support remains a separate exact-scoped admin surface. The API actions are present,
  but there is no client participant-management UI yet.
- Support creation and message append are the first canonical domain actions shared below route
  adapters. They require trusted HUMAN/AGENT/SYSTEM actor context, enforce visibility and scope,
  and transactionally couple version CAS, content evidence, support audit, and platform audit.
- Client and operator messages may reference only exact-scope quarantined intake uploads whose
  stored version, MIME, size, checksum, FILE_UPLOAD run and immutable evidence correspond. The
  server derives the attachment snapshot, client reuse is uploader-bound, and durable operation
  UUID/hash replay converges ambiguous create/reply outcomes before request-version CAS. The UI
  truthfully exposes transport verification and review status only; it provides no file preview,
  download, malware-safety, approval or publication claim. Explicit participants still may attach
  only their own uploads. The additive migrations are unapplied.
- Client-visible Support mutations advance a dedicated `clientVersion` and `clientActivityAt`, while
  the global request version and internal activity remain separate operator concurrency/history
  evidence. Client lists sort on client activity, so internal-only work neither leaks nor resurfaces a
  request. Client read models return only authorized requests and `CLIENT_VISIBLE` messages.
- A normalized support-to-package handoff can link an exact support request version to an existing
  same-tenant, same-venue `DRAFT` VenuePackage. The append-only handoff is HUMAN-operator attributed,
  version-CAS guarded, strictly audited, and makes zero package lifecycle writes. Its forward-only
  migration is intentionally unapplied.
- Verified support status transitions use an explicit closed graph from `OPEN` through information,
  review, patch, validation, approval and applying states to `COMPLETED` or `CANCELLED`. Only a HUMAN
  `OPERATOR` may transition, with exact tenant/venue scope, expected version/current-status CAS, and
  transactional append-only support event plus strict platform audit. Transitions do not execute
  package lifecycle work. `VALIDATING` truthfully covers validation/evaluation review because the
  persisted enum has no separate evaluation state.
- Human support triage can set a validated category and bounded missing-information checklist with
  exact request-version CAS, one version increment, append-only `TRIAGE_UPDATED` evidence, and
  redacted strict audit. It never changes status, sends a message, or touches package lifecycle.
- Operational-update create, edit, schedule and deactivate mutations now route through canonical
  HUMAN manager/owner domain actions. They enforce exact tenant/venue/place scope, content-version
  locking, optimistic `updatedAt` CAS, bounded overlapping published updates, valid time windows,
  transactional strict audit, and a truthful guest-visibility preview. These local actions do not
  prove that production schedulers or expiry behavior are running.
- VenuePackage approve/apply/revert lifecycle authority is shared through one stateless core. Tenant
  adapters retain HUMAN `OWNER` authorization; exact-scoped Internal Workspace adapters use the real
  HUMAN `PLATFORM_ADMIN` identity and role. Both preserve tenant/venue/package scope, venue locks,
  actor-bound command replay/collision handling, status/`updatedAt` CAS, content-version context and
  strict sanitized transactional audit. Existing V1/V2/V3 effect and rollback behavior is unchanged.
- Weekly-report configuration, draft edit, and publish now use neutral HUMAN platform-admin actions
  with exact scope, locks, CAS, legal DRAFT transitions, default-off configuration, and strict audit.
  Generation rejects inverted week ranges before durable work and retains existing post-commit
  dispatch behavior. The client surface loads bounded cursor-paginated published summaries and an
  exact tenant/venue/report detail with semantic text rendering and honest route states; it adds no
  notification or delivery behavior.
- Client/account create and metadata changes use canonical actions. Provider-backed creation is
  fenced by a durable pre-Clerk request intent and append-only lifecycle evidence; ambiguous outcomes
  cannot auto-retry and require verified organization/owner/email reconciliation. Client status,
  plan, and local payment-due metadata use exact CAS and never charge a payment method.
- Content-history recovery now uses a neutral HUMAN manager/owner action with exact
  tenant/venue/entity locks, latest-version CAS, trigger attribution, strict versioned snapshot and
  parent-scope validation, P2002/P2003 conflict mapping, and sanitized same-transaction audit.
  Venue restoration/deletion remains owner-only; transport response contracts are unchanged.
- Tenant engagement-mode changes now use a neutral HUMAN owner/manager action with server-resolved
  tenant scope, exact `updatedAt` CAS, monotonic revision propagation, idempotent same-revision
  no-op behavior, and strict sanitized audit in the mutation transaction. Pending Clerk invitation
  reads are OWNER-only; invitations remain provider-first and do not manufacture a local membership
  before the existing verified webhook synchronization observes one. The revision-aware manager
  component is type-compatible and locally tested, but `/engagement-questions` still redirects home;
  there is no reachable production control, so this is not end-to-end UI evidence.
- Answer-analysis requests now use a neutral HUMAN platform-admin action for exact tenant/venue,
  active-venue, range, UUID replay, snapshot/dispatch and sanitized transactional audit; inverted
  ranges fail before durable work and enqueue remains a post-commit best-effort kick.
- Internal chatlog notable and note review use neutral HUMAN platform-admin actions with exact
  tenant/venue/session scope, CAS or UUID replay, and strict transactional audit. General audit
  evidence records note length rather than private note text, and the form safely retains or rotates
  its request key across ambiguous retries.
- Guest chat sends now reserve a durable tenant/venue/session-scoped turn keyed by a client operation
  UUID and canonical request hash. Exact two-kind provider receipts carry stable invocation identity;
  completed replay performs no provider/spend work, and dispatched uncertainty never redispatches.
  Proven expired pre-dispatch orphans fail safely, while dispatched or response-observed orphans
  reconcile terminally so a reload cannot strand the session.
- One serializable final transaction writes the sequenced user/assistant pair, engagement response,
  pending-question/session state and validated replay evidence. History uses monotonic session
  sequence as authority. The guest UI retains frozen input for ambiguous retry and, on terminal
  precondition failure, reconciles authoritative history and rotates to a new operation identity.
- Public analytics now resolves the browser bearer token through exact tenant/venue session scope
  before persisting the internal session ID; provider error logging and analytics omit guest text and
  bearer values. Forward migration `20260812000400_add_durable_guest_chat_turns` includes legacy
  analytics resolution/backfill and exact composite foreign keys, but remains unapplied.
- Global AI incident-control mutation now uses a neutral HUMAN platform-admin action with validated
  reason/revision input, exact configured-state CAS, same-state replay, malformed-state fail-closed
  repair, first-create collision handling and strict same-transaction audit. The router remains a
  transport adapter; changing the durable admission control does not call an AI provider.
- Weekly-digest requests now create or reconcile the tenant/week durable intent before queue I/O.
  HUMAN platform-admin and the identified system scheduler share the neutral action; `PENDING`
  retries may enqueue, `PROCESSING`/`COMPLETE` do not, and `FAILED` is CAS-reset with strict audit.
  Deterministic queue publication can redrive retained terminal failures and confirms concurrent
  queue state, but no scheduler, Redis or provider behavior was exercised live.
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
- A neutral `packages/db` intake service now owns tenant/venue-scoped proposal creation and reads,
  privacy-preserving interview evidence, and append-only events. Reviewed structured-bootstrap and
  interview sources use a deterministic server-rebuilt candidate to create and atomically link a
  new `DRAFT`; arbitrary existing-draft linkage is not exposed. Website and quarantined-file intake
  remain proposal/evidence only. No intake path approves, applies, or publishes a package, and its
  migration remains unapplied.
- A separate quarantined file-intake seam accepts bounded PDFs and safe raster-image MIME types.
  It persists an actor-bound request before signing a create-only private PUT, uses a fenced
  verification lease, and creates a `FILE_UPLOAD` intake run only after exact generation, byte,
  MIME, checksum and storage-version verification. Client and operator surfaces expose safe
  metadata without preview or download. Format parsing, malware scanning, extraction, package
  creation, approval, apply and publication remain deliberately unavailable.
- Reachable tenant and platform-admin text-only staff-interview capture/review uses five
  role-specific question sets, exact consent, required answer/skip/redact representation,
  uncertainty/confidence controls, monotonic privacy, and public-only candidate text. Durable
  actor/tenant/venue/payload-bound UUID replay and synchronous submit fences prevent duplicate runs;
  review exposes typed field paths, structured public candidate/discrepancy summaries, safe evidence
  and timeline metadata, and truthful handoff readiness. Recording/audio/video fields are
  structurally rejected; no interview action approves, applies, publishes, fetches, or records media.
  The forward-only source-shape correction that permits proposal request identity is locally
  contract-tested and intentionally unapplied.
- Browser-safe Venue Deployment Manifest v2 contracts support FULL and granular PATCH packages with
  identity, branding/assets, versioned AI/tone/model references, effective configuration provenance,
  typed content/evidence, readiness/evaluation, immutable hashes, base hash, and idempotency. Patch
  operations use stable-ID upsert/retire/reset; tenant authority, secrets, binaries, unsafe URLs, and
  monolithic content replacement are rejected. A read-only admin review/conversion seam validates a
  manifest and exposes exact inputs for the existing `venuePackage.preview` and `createDraft`
  lifecycle. It never persists, approves, applies, rolls back, or queues work; V2-native persistence
  and apply/rollback remain pending.
- The same internal screen can project one exact tenant/venue's safe current configuration fields
  into a caller-enveloped, FULL-contract-validated canonical preview and reviewed JSON download.
  The projection is not an immutable publication snapshot and is always `NOT_READY`: generalized
  content, immutable assets, capability truth, model references and readiness evidence remain
  explicitly omitted. It creates no package or database row and exposes no apply action.
- Internal Workspace now also has a bounded Venue Package history/detail and deliberate lifecycle
  surface. It revalidates the stored payload schema and venue-bound canonical hash, plus preview
  schema, payload/base/warning digests and validation-report identity before displaying evidence. A
  HUMAN platform administrator can review every warning and the exact immutable payload,
  acknowledge that evidence, then deliberately advance `DRAFT` → `APPROVED` → `APPLIED` or confirm
  `APPLIED` → `REVERTED`. Stable command identities survive ambiguous responses, synchronous fences
  prevent duplicate submits, conflicts require authoritative readback and strict audit remains
  atomic. This local surface adds no publish action, provider call or live deployment evidence.
- The authenticated Client Portal has an exact package-bound static preview for an eligible
  `APPROVED` Venue Package. A shared `RepeatableRead` predicate distinguishes exact base drift
  (`SUPERSEDED`) from missing, corrupt, incomplete or safely unrepresentable evidence
  (`UNAVAILABLE`) and returns a bounded full-effective V1/V2/V3 visitor projection with public
  branding, versioned tone, coordinates, active Places and enabled Knowledge. It exposes no internal
  entity IDs, hashes, validation/provenance evidence, guide instructions or guest-public URL and
  performs no apply, publish or provider work.
- Preview feedback is a distinct replay-safe HUMAN-client Support action. It revalidates that same
  exact current approved preview and atomically persists the Support request/message, trusted
  quarantined-upload references, append-only tenant/venue/package lineage, support event and strict
  sanitized platform audit. It has no package lifecycle/content side effects. Forward-only migration
  `20260812000300_add_support_preview_feedback` is unapplied; local schema and focused tests are not
  live database or deployment evidence.
- Deliberate platform-admin controls can create a reviewed Venue Package DRAFT through the existing
  globally and venue-gated, budgeted semantic-analysis pipeline. Standalone, support-request and
  intake-review variants require complete semantic evidence; support/intake linkage, strict audit,
  and the DRAFT are finalized atomically. Actor-bound replay and UI request-key fencing handle
  ambiguous retries. These controls never approve, apply, publish or revert content, and no live
  provider execution was performed for local verification.
- A central AI workload configuration registry/resolver and additive persisted control plane model
  provider/model identity, fallback, cost and budget bounds, and platform→workload→client→venue
  precedence with field-level source attribution. Global workload and exact tenant/venue overrides
  are disabled by default, version-CAS protected, reset through tombstones, and backed by strict
  audit plus database-guarded immutable history. The platform-admin API/view can inspect
  effective/source/override state and deliberately stage venue edits without storing credentials,
  calling a provider, or replacing the runtime budget gate.
- Offboarding contracts require evidence-backed revocation of guest links, widgets, API/MCP access,
  jobs, agents, client access, and impersonation plus export manifests. They explicitly cannot
  authorize deletion while retention policy remains owner/legal gated.
- Tenant-scoped offboarding plan, venue-target, revocation-evidence, and export-artifact persistence
  is defined in a forward-only migration with append-only and delete guards. Admin APIs may only
  list/get/create a REQUESTED plan through one neutral HUMAN PLATFORM_ADMIN action with exact
  tenant/venue validation and strict same-transaction audit; no revocation, completion, retention,
  or deletion action exists. Draft creation now binds a caller-generated UUID to a canonical SHA-256
  hash of normalized planning input under an exact tenant/request lock. An unchanged retry returns
  the existing plan without duplicate audit; key reuse for different input or actor conflicts.
- Client-scoped internal Offboarding console displays venue targets, all required revocations,
  append-only evidence, and export metadata. Operators may only create a confirmed REQUESTED draft;
  the UI prominently states that retention is unresolved and exposes no execution/deletion control.
- The same console offers a read-only export-manifest preview for up to 20 selected venues. It
  returns capped metadata/references and explicit truncation evidence for venue identity, current
  content IDs, history, package hashes/status, and PUBLIC/CLIENT normalized-content lineage. It
  omits bodies, snapshots, private support/guest data, source locators, assets and secrets, and
  creates or stores no export artifact.
- AA-aware guest accent/text contrast selection and reduced-motion-safe reveal behavior. The
  browser-safe structured response envelope now includes bounded choices, HTTPS-only image/gallery,
  event and location blocks in addition to text, callouts, actions, citations and places. Unknown
  blocks and credential-bearing media/map URLs fail validation; legacy text/place replies remain.
- Dark shared credential persistence now models tenant/client/optional-venue and capability scope
  for future MCP and Partner Read API authentication. Credentials default disabled and persist only
  an Argon2id verifier plus non-sensitive prefix; admin APIs/UI expose safe paginated metadata only.
  Append-only rotation/revocation evidence exists structurally, but issuance, verification,
  enablement, rotation, revocation, transport and `lastUsedAt` updates are not implemented.

### PathFinder OS

- Responsive internal OS shell with persistent, grouped navigation.
- Global Cmd/Ctrl-K client lookup backed by authorized, server-filtered bounded admin data.
- Attention-first command center replacing the prohibited endless-directory homepage.
- Operational exception triage for AI incident state, failed/retryable jobs, evaluation lifecycle,
  pending/expired approvals, support workflow attention, recent agent runs, suspended clients, and
  setup accounts. Every queue is bounded, cursor-paginated, read-only, and omits sensitive payloads.
- Weekly-report operations use a bounded stable cursor over report history, preserve date filters
  across pages, and recover malformed bookmarked filters/cursors to an accessible newest-page
  state. A failed report remains immutable evidence; its retry is namespaced to that terminal report
  so the first retry is a fresh durable request and an ambiguous retry reuses only that new identity.
- Recent work, operational status, compact recent operations, a separate client directory, and a
  dedicated operations view. The directory now uses server search and stable cursor pagination;
  the legacy all-client procedure is compatibility-bounded.

### Client and guest surfaces

- Ultra-Simple Client Portal reconstruction: no analytics, responsive calm navigation, lifecycle
  status, single-venue-first home, unobtrusive multi-venue switching, operational updates, simple
  tone controls, real venue-scoped support requests/replies with conflict-safe draft retention, and
  per-request requester/participant isolation with uploader-owned quarantined-evidence attachment
  selection, plus platform-admin-only links back to internal tools. The Support UI safely labels an
  authorized non-requester as `Your team`; participant grant/revoke is API-only in this build.
- Client lifecycle is derived, not stored as a new mutable claim. The browser-safe resolver and
  tenant-scoped read model map existing venue, intake, package and offboarding evidence to the ten
  packet states and show only client-required tasks and human milestones.
- Advanced legacy client URLs redirect to the approved simple portal destinations instead of
  rendering analytics, design, venue-management, content-editing or other internal tools. URLs are
  retained as compatibility redirects rather than deleted.
- Premium onboarding reframed around modest raw client input, private assembly milestones, and
  preview rather than asking clients to design the knowledge system themselves.
- Guest structured response renderer foundation with backward-compatible text/place responses plus
  callouts, safe actions, citations, typed places, choices, images, galleries, events and locations.
- Route-level loading states and reduced-motion-safe transitions across the rebuilt surfaces.
- Human freshness review can confirm an active Place or Knowledge record as current, optionally
  repair safe provenance metadata, and atomically record paired reviewer/confirmation attribution.
  Secret-bearing source URLs fail before transaction; review never changes factual content or
  publishes a patch.

### Internal operations and agent foundations

- Scope-aware Internal Client Workspace with client/venue breadcrumbs, grouped workflows, venue
  switching, readiness warnings, guest preview, and advanced controls separated from client UI.
- Internal-only legacy compatibility management exposes scoped Place/Knowledge create, CAS edit,
  and soft-retire actions to platform admins without restoring these tools to the Client Portal.
- Admin-only Universal Content explorer groups typed modules and shows version, audience, effective
  state, and provenance summaries with strict venue scope and cursor pagination. Places/Knowledge
  remain explicitly labeled compatibility systems and are mutable only in the Internal Workspace;
  neither system is exposed through the client or guest surface.
- Agent identity, run, action, access/autonomy, timeline, and reusable approval persistence
  primitives with append-only and cross-scope migration guards.
- Canonical approval-decision action requires a human platform admin, exact tenant/venue/request,
  pending and unexpired state, single-decision conflict handling, and strict audit in one
  transaction. The admin form records evidence only and explicitly cannot execute proposed work.
- Tenant/venue-scoped, paginated admin read APIs for agent identities, runs, actions, timelines, and
  approvals; raw action payloads and artifacts are intentionally excluded.
- Venue Agent Operations views separate access scope from autonomy and expose runs, lifecycle
  timelines, action/version summaries, fixed-point cost, and approval state. A human platform admin
  can record cancellation intent for an exact cancellable run with conflict-safe replay, append-only
  timeline evidence, and strict sanitized audit in one transaction; this control does not call a
  provider, change run status, enable an identity, run/retry work, or execute an approval.
- Read-only Evaluation Operations API and venue console separating operational failures from scored
  quality outcomes and showing frozen model, prompt, content, package, and corpus identities plus
  bounded human conclusions.
- Versioned canonical venue-content snapshot hashing covers exact guest-facing venue, place,
  knowledge, current operational-update, prompt/config, and latest effective PUBLIC universal
  content fields with stable ordering and NFC. Internal audiences, provenance metadata, embeddings,
  and audit timestamps are excluded from the content identity.
- Default-off evaluation admission freezes server-derived case/model/prompt/content identities and
  enforces 1–50 cases plus a $1 request ceiling. Requests persist as `STAGED`; a separately gated
  durable dispatcher advances and idempotently publishes `QUEUED` work, while the registered worker
  records retry, cancellation, budget, operational-failure, and scored-quality evidence. Process,
  durable-global, and tenant gates all remain off until explicitly and separately enabled.
- Read-only Freshness Audit queues for overdue human-reviewed sources, provenance metadata gaps, and
  expired/soon-expiring operational updates. The console never represents metadata gaps as factual
  contradictions and exposes no patch/publish action.
- Internal Support Operations console separates client-visible replies from internal notes, exposes
  append-only request evidence and package lineage, and limits verified operator mutation to
  conflict-safe messages/notes, closed-graph status transitions and the bounded existing-DRAFT
  handoff described above. Its platform-admin authorization and explicit scope remain independent of
  tenant requester/participant membership.
- Default-off flags for richer guest components, generalized capabilities, onboarding automation,
  autonomous support actions, MCP writes, partner API, and SDK release.
- MCP v0 contracts and a transport-neutral adapter registry targeting official protocol revision
  2026-07-28: 12 scoped resources, read/draft/bounded-evaluation tools, strict structured results,
  verified credential context, default-off writes, and exact approval/scope/capability checks. All
  12 read resources now have bounded exact-scope safe-select bindings with resource-bound cursors and
  output-layer leakage filtering. Disabled hashed credential metadata has a persistence/read
  foundation, but issuance, verification, transport, OAuth, rate limiting and live authentication
  remain intentionally unimplemented and dark.
- Dark Partner Read API v1 contracts and registry for six bounded operations. Availability requires
  the exact default-off flag plus injected revocation, expiry, rate-limit, audit, scope, and canonical
  read dependencies; shared disabled hash/prefix metadata persistence does not supply authentication.
  There is no listener, issuance/verification lifecycle, live binding, SDK, or public launch.
- Unified internal search is tenant-authorized and server-filtered across bounded result groups for
  clients, venues, content, support, agents, jobs, packages and evaluations. The command palette is
  navigation-only; production-scale relevance and latency remain live-unverified.

### Additional foundations completed locally

- A neutral, worker-safe Intake Engine now provides deterministic source deduplication, bounded
  orchestration, evidence and discrepancy reconciliation, cancellation and cost limits, and a
  draft-for-review-only handoff. The website adapter is concrete and SSRF/redirect/DNS bounded;
  staff interviews are consent-gated and text-only. Other source adapters report
  `NOT_CONFIGURED` instead of pretending to ingest.
- Universal normalized content persistence is additive and typed: payload-free identities,
  immutable revision envelopes, separate Service, Policy, Event, Operational Fact, and
  Relationship payloads, and append-only evidence. Exact tenant/venue/kind constraints prevent a
  generic lowest-common-denominator content table. Default-off operator actions create identities,
  append CAS-protected typed revisions, or append retirement boundaries with strict audit evidence.
  A separate append-only publication ledger makes guest publication explicit: only the exact latest
  `PUBLIC` revision may be published, withdrawal requires the expected published revision, UUID
  replay/collision is bounded, and audit commits with the event. The feature-gated guest resolver
  returns only latest effective published Service, Policy, Event, Operational Fact and Relationship
  payloads in stable bounded order; authoring a `PUBLIC` revision alone is still not publication.
  Its forward migration remains unapplied and no live guest/provider path was run.
- Venue Deployment Manifest v2 contracts support complete and granular patch manifests with
  stable-ID operations, effective configuration provenance, immutable asset references,
  evaluation/readiness evidence, canonical hashing, and deterministic diffing. The existing
  package v1-v3 lifecycle remains the persisted compatibility path. The reviewed conversion seam
  can produce exact preview/draft inputs but cannot mutate lifecycle state. The FULL projection is
  a read-only canonical review artifact over safe current venue fields and remains `NOT_READY` with
  generalized modules, immutable assets, capabilities, model references and readiness omitted.
- Offboarding persistence and the operator console can create and inspect requested plans,
  revocation targets, evidence, and export metadata. Execution and deletion remain absent by
  design pending authorization and retention policy.
- Evaluation dispatch and runner foundations are implemented with frozen identities, case and
  budget caps, legacy-safe lifecycle migration, cancellation races, retry result reuse/prior-spend
  accounting, and separate quality/operational outcomes. The worker is registered only behind its
  default-off process gate; durable-global and tenant gates independently fail closed.
- Agent identities can be created disabled, edited only while disabled with exact-scope CAS, and
  disabled from the Internal Workspace. Closed capability/action contracts and strict transactional
  audit evidence are present; there is intentionally no enable, run, provider, model, credential, or
  autonomous-execution control.
- Cross-migration integrity checks cover the ordered intake, support-package-handoff, dark
  credential, and proposal-identity correction migrations against the final Prisma schema, tenant
  registry and append-only guards. Custom intake index names are explicitly mapped in Prisma; the
  checked migrations are atomic and
  use restrictive exact-scope foreign keys. Offline format/validate/generate and the DB suite passed,
  but none of these forward migrations, including durable guest chat turn migration
  `20260812000400_add_durable_guest_chat_turns` and requester-isolation migration
  `20260812000500_support_requester_isolation`, was applied or rehearsed against a database.

## Required program work not yet proven complete

- Remaining Internal Client Workspace deep capability views and domain-action adapters.
- Intake adapters beyond website and text-only staff interviews, plus live extraction and
  end-to-end reviewed onboarding beyond the bounded reviewed-DRAFT handoff boundary.
- Venue Deployment Manifest v2-native persistence/apply semantics beyond the bounded conversion into
  existing preview/draft inputs.
- New account/workspace mutation surfaces must continue to use the canonical actions; the current
  production routers contain no direct Tenant, User, or TenantMembership writes outside those seams.
- Support workflow beyond verified status transitions and reviewed-DRAFT creation/linkage,
  including a client participant-management UI and any later automated approval, apply, completion
  or agent orchestration.
- Agent execution adapters and protected enable/run/retry controls; staged identity configuration
  does not activate an agent.
- MCP transport/authentication, credential issuance/verification/lifecycle, write bindings, and any
  staging-justified thin SDK.
- Live evaluation gate activation/provider execution and report-quality evidence, reports lifecycle redesign, and
  authorized offboarding execution.
- Remaining table pagination/batching/virtualization work and measured browser performance
  evidence. Admin client lookup/directory and portal eager analytics/report fetches are already
  corrected.
- Full desktop/mobile visual QA, real-browser E2E and assistive-technology review, and migration
  rehearsals.

## Local browser-surface foundation

`pnpm test:browser-foundation` now runs 88 deterministic DOM and route-adapter contracts across the
Admin OS, Internal Client Workspace, ultra-simple Client Portal, and Guest experience. The gate is
wired into CI and performs no authentication, network, provider, or database access. It is an inner
loop foundation, not Playwright or deployed-browser evidence: browser-engine layout, Clerk flows,
visual regression, and authenticated staging remain unverified.

`pnpm test:accessibility` adds a second CI-wired local gate. Six axe-core contracts scan the mounted
document for representative Admin OS, exact-scoped Internal Workspace, real client-portal shell,
real standalone guest-chat shell and structured-response states. The scan found and corrected
landmark defects in both workspace and guest production shells. Only color contrast is disabled in
jsdom because it cannot compute layout or pixels; real-browser contrast, zoom/reflow, high-contrast
mode and assistive-technology evidence remain unverified.

- Isolated live staging, alert delivery, promotion, restore, and production evidence where owner
  authorization is required.

## Verification evidence boundary — 2026-08-11

- Final merged `pnpm typecheck`: 23/23 tasks passed across 13 workspaces.
- Final merged `pnpm lint`: 13/13 tasks passed with zero errors and one existing guest
  `no-img-element` warning in `PlaceCard.tsx`.
- Final merged `pnpm test`: 2,522 tests passed, 134 configured/intentional tests skipped, and zero
  failed. This includes 135 passing structural/security script tests and one intentional legacy
  fixture skip.
- Final merged `pnpm build`: 13/13 tasks passed, including both optimized Next.js applications.
  Existing Sentry/OpenTelemetry dynamic-require and Windows standalone-link warnings remain.
- Static boundaries passed: 72-model tenant registry, 66 tenant procedures, 123 reviewed tenant
  bypasses in 39 production files, 811-file AI-provider review, 12 budgeted gateway sites, 62 raw
  SQL operations, six public tRPC procedures, six public HTTP modules, one dashboard public API
  path, and 310 browser files scanned against 11 credential/secret canaries.
- Prisma format, validation, and client generation for the three new forward-only migrations used
  dummy loopback URLs only. The migrations remain unapplied and have no live-schema evidence.
- No database, Redis, provider, migration-apply, staging, or production operation was executed.

Live browser visual/E2E evidence is not claimed: the in-app browser had no connected runtime, and
starting a data-backed application against an unidentified environment would violate the active
database incident stop.

## Completion evidence policy

Packet 2 is complete only after every explicit section is mapped to authoritative code, tests,
rendered/browser behavior, operational evidence, or an owner-only decision. A passing typecheck or a
finished local slice is not evidence of live readiness. Code-complete and live-verified states must
remain distinct.
