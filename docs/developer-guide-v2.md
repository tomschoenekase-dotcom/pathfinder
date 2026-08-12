# PathFinder developer guide v2

## Dependency direction

- `packages/contracts`: browser-safe schemas and deterministic helpers.
- `packages/config`: environment parsing, feature flags, logging, and incident controls.
- `packages/db`: Prisma client, tenant middleware, canonical transactional actions, and persistence
  helpers.
- `packages/ai`: model/embedding registries and the only provider gateways.
- `packages/jobs`: queue names, payload contracts, and enqueue admission.
- `packages/intake-engine`: source-neutral orchestration with injected adapters.
- `packages/api`: authenticated transport adapters over domain actions.
- `apps/workers`: job processors; never import dashboard, web, or API routers.
- `apps/dashboard` and `apps/web`: presentation and user interaction only.

## Adding content or capabilities

Prefer a typed contract and typed persistence payload over a generic content blob. Keep archetype,
preset, audience, capability, and feature flag axes separate. Add effective-value tests that prove
precedence, source attribution, override, reset, and restricted-audience filtering before retrieval.

## Client lifecycle and route boundaries

Resolve portal lifecycle with `@pathfinder/contracts` from explicitly selected, tenant-scoped
evidence. Do not add a second mutable lifecycle field or let presentation code infer progress from a
single optimistic flag. New client portal pages must fit the approved simple functions. Advanced or
internal legacy routes retain URL compatibility through a server redirect and need a route test that
proves the internal component cannot render.

`CLIENT_PREVIEW` is an authenticated, package-bound static read, not the ordinary guest slug. The
lifecycle read exposes an exact eligible `APPROVED` package ID only while retained review evidence
and the current base agree. Exact base drift is `SUPERSEDED`; missing, corrupt, incomplete or safely
unrepresentable evidence is `UNAVAILABLE`. The `RepeatableRead` detail returns a bounded effective
V1/V2/V3 visitor candidate: public branding, versioned guide tone, coordinates, active Places and
enabled Knowledge. It omits internal entity IDs, hashes, item keys, provenance, validation details,
guide notes and raw instructions. It does not publish, apply, call a provider or become guest-public.

## Adding a domain action

Define an explicit actor (`HUMAN`, `AGENT`, or `SYSTEM`), exact tenant/venue scope, input contract,
idempotency or CAS behavior, and durable audit evidence. Make mutation plus required audit atomic.
Routers, workers, MCP tools, and future agents should call this action rather than duplicate it.

The support-package handoff is the narrow reference example: exact tenant, venue, support request,
request version and existing `DRAFT` package; HUMAN operator; CAS; append-only lineage; atomic audit;
zero package lifecycle writes. Do not broaden that helper into implicit create/approve/apply or
support completion. Support transitions use a closed graph, HUMAN `OPERATOR` authorization, exact
scope, expected version/current-status CAS, and transactional append-only support/platform audit.
They have no lifecycle execution side effects. `VALIDATING` includes validation/evaluation review
because the persisted enum has no separate evaluation state.

Support attachments are typed references to existing quarantined `IntakeUpload` evidence, never
browser-authored filename, MIME, byte-size or storage metadata. Resolve every reference inside the
message transaction with exact tenant/venue scope, uploader ownership for client actors, terminal
transport evidence and one matching FILE_UPLOAD evidence row. Create and reply operations retain a
UUID and canonical actor/scope/content/attachment hash across ambiguous retries; replay must be
checked before reply-version CAS. Safe projections omit upload/run/hash/storage identities, and
strict audit records only attachment count. This boundary does not authorize reading file bytes.

Tenant Support access is request-scoped, not role-wide. The immutable requester and any unrevoked
explicit participant must still have an `ACTIVE` membership; `STAFF`, `MANAGER`, and `OWNER` use the
same requester-or-participant predicate and no role implicitly grants access to another member's
request. Only the requester-facing canonical actions may grant or revoke an active member, with an
actor-bound UUID/hash and `clientVersion` CAS. The requester can never become a participant, and
grant evidence is retained when access is revoked. Client-visible mutations advance
`clientVersion`/`clientActivityAt`; global `version` and internal activity remain the operator
concurrency/history boundary and must not reorder the client queue. Client projections expose only
current-user requester/participant booleans and safe messages, while the UI labels an authorized
non-requester as `Your team`; they never disclose the requester or participant directory. Participant
access does not transfer upload ownership: each client actor may attach only that actor's own eligible
quarantined upload. Platform-admin Support reads and mutations remain a separate admin procedure with
exact tenant/venue/request scope, not a path through the tenant ACL.

The manual Support conversation loop uses three dedicated canonical actions rather than the generic
status graph. A HUMAN platform operator may request a bounded missing-information checklist from an
`OPEN` or `IN_REVIEW` request, atomically recording the client-visible prompt and moving it to
`WAITING_FOR_CLIENT`. The immutable requester or an active participant may answer only from
`WAITING_FOR_CLIENT`; the action resolves that actor's eligible attachments, clears the checklist,
records the client-visible response and returns the request to `IN_REVIEW`. A HUMAN platform
operator may manually complete only an `OPEN` or `IN_REVIEW` request whose checklist is empty, with
an explicit client-visible completion message. Each action advances global and client versions,
records append-only request evidence plus strict sanitized audit, and binds replay to actor, scope,
content and immutable produced-version evidence. These actions never create, approve or apply a
package and never dispatch execution. Operator prompt/completion actions accept no attachments.

The client portal task projection must reuse that same ACL, first verify exact tenant/venue scope,
and return only bounded client evidence. Missing-information tasks expose at most three requests and
five items per request with explicit remaining counts. Tenant intake review is a positive allowlist:
id, role, consent state, and safe prompt/privacy/retention/public-text fields only. Never send
confidence, discrepancies, readiness, timelines, hashes, evidence internals, field paths, or
automation metadata to the tenant browser. Admin review retains its separately authorized detail.

Approved-preview feedback is a separate canonical support action. Session tenant and HUMAN client
identity are authoritative. Inside one `RepeatableRead` transaction it revalidates the same current
eligible `APPROVED` preview, then creates the Support request, immutable message, trusted attachment
links, append-only exact package-feedback lineage, support event and strict sanitized audit. Its
replay hash binds actor, scope, package, normalized text and sorted attachment IDs and converges
P2002 races. It never changes package status/content or invokes AI, a provider, apply or publish.

Operational updates are another canonical-action reference: HUMAN manager/owner authorization,
exact tenant/venue/place scope, content-version entity and capacity locks, expected `updatedAt` CAS,
bounded overlap validation, and required audit in one transaction. API adapters validate and
authorize before calling the helper; they must not recreate mutations in route code. Intake
proposal creation, listing, and privacy-safe review evidence live in the neutral DB service so
tenant and admin adapters share the same scope and privacy rules. Reviewed bootstrap/interview
package creation calls the ordinary stateless VenuePackage draft service with explicit database,
tenant, HUMAN `MANAGER`/`OWNER`/`PLATFORM_ADMIN` actor and optional same-transaction finalizer. Tenant
and admin adapters retain truthful actor roles. Never call a router from another router, fabricate a
tenant session, or hide finalization in mutable or async-local state. Finalizers atomically link only
the server-rebuilt semantic-complete `DRAFT`.

Legacy Place and Knowledge compatibility writes now use neutral create, CAS update, and soft-retire
actions. They lock the exact tenant/venue entity, set content-version context, require strict audit in
the same transaction, and leave trigger-backed embedding dispatch to the database outbox. Do not
reintroduce direct router writes or dual-write normalized content. Human freshness review uses the
same exact scope and `updatedAt` concurrency boundary but may update review/provenance attribution
only, never factual content or publication state. Support triage uses request-version CAS and must
remain separate from status transitions, client messaging, package lineage, and execution.

Venue creation and configuration also route through neutral actions. Normalize and validate slugs
inside the domain boundary, serialize automatic suffix allocation with the tenant/base advisory
lock, rotate monotonic `updatedAt` tokens, and preserve tone preset/version mappings. Nested initial
content relies exclusively on the durable embedding-dispatch trigger/outbox; never add a second
direct queue enqueue. The destructive venue-delete helper requires a HUMAN `OWNER` before opening a
transaction, even when its current transport adapter already enforces the same role.

Content-history recovery is also a neutral action rather than router-owned persistence. It locks
the exact tenant/venue/entity, compares the latest content-version ID, installs trigger attribution,
strictly validates the selected versioned snapshot and parent scope, then requires sanitized audit
evidence in the same transaction. Venue restoration/deletion remains HUMAN `OWNER` only. Keep
snapshot compatibility parsing isolated from orchestration, and never accept unknown snapshot
fields or bypass trigger-backed history when adding a schema version.

VenuePackage lifecycle transition authority is neutral and shared. Tenant adapters require a HUMAN
`OWNER`; exact-scoped Internal Workspace adapters require a HUMAN `PLATFORM_ADMIN` and retain that
truthful audit role. Both call the same stateless core with exact tenant/venue/package scope, venue
locking, actor-bound command replay/collision, revision CAS, content-version context and strict
transactional audit. Approval binds the acknowledged payload and warning digests; apply and revert
retain the V1/V2/V3 effect and rollback rules inside the same outer transaction. Never impersonate a
tenant owner, split effects from final transition, or replace legacy rollback with V3 rules.
Weekly-report configuration/edit/publish actions are similarly neutral, but generation dispatch is
an orchestration concern and must reject an inverted range before any transaction. Client creation
uses a durable pre-provider intent: commit `PROVIDER_STARTED` before Clerk I/O, block ambiguous retry,
and reconcile only after revalidating the exact organization, owner-equivalent membership, and email.
The intent/event migration enforces its state machine and append-only evidence; it remains unapplied.

Internal weekly-report history must remain an exact tenant/venue safe-select with a bounded
`(weekStart, id)` descending cursor. Route query parsing is fail-safe: canonical calendar dates and
complete cursors are accepted; malformed, reversed or partial inputs render the recent/newest state
with accessible warning copy. A terminal failed-report retry adds the failed report ID only to the
client idempotency fingerprint, guaranteeing a fresh first retry while retaining that retry's UUID
across an ambiguous response. The retry seed is not sent to or persisted by the server.

Tenant engagement policy is also a canonical DB action. Pass the server-resolved tenant, HUMAN
`OWNER`/`MANAGER`, and the tenant revision loaded with settings; propagate the returned `updatedAt`
before the next edit. A matching revision/mode is an idempotent no-op, while stale revisions fail
with `CONFLICT`. Clerk invitations are deliberately different: Clerk remains the external source of
truth and verified webhook synchronization owns local membership persistence. Do not pre-create a
membership or claim provider/local atomicity in the invitation route. The existing
`EngagementQuestionsManager` demonstrates revision propagation only; its legacy portal route remains
redirect-only. Do not cite that dormant component test as evidence of a reachable client control.

Guest design is an exact-scoped Internal Workspace admin boundary with the real HUMAN
`PLATFORM_ADMIN`, revision CAS and strict audit. Branding assets may only retain the currently
reviewed reference or clear it; this is not an upload seam. Its style card is deliberately
non-literal, while the client portal remains tone-only.

## Adding an intake adapter

Implement the adapter interface in `@pathfinder/intake-engine`. Bound time, size, count, evidence,
cost, redirects, and cancellation. Preserve citations and privacy classes. Unsupported sources must
return `NOT_CONFIGURED`. The adapter may produce a draft proposal but cannot approve or apply it.
Persist proposals through the neutral `packages/db` intake action. Candidate content must contain
only material authorized for that audience; keep withheld input as manifest or hash evidence.
Reviewed structured-bootstrap and interview sources may create and atomically link only the
deterministic server-rebuilt `DRAFT` candidate. Website and quarantined-file sources remain
proposal/evidence only. Intake exposes no arbitrary existing-draft link, approve, apply, or publish
operation.

Website and text-interview proposal mutations require a browser-generated UUID. The neutral action
binds that request identity to the exact tenant, venue, actor, source kind, and canonical validated
payload under a transaction advisory lock; exact retries replay the prior run and collisions fail.
Keep the UUID stable across an ambiguous response, rotate it whenever the form payload changes, and
rotate it after confirmed success. Staff-interview answers must cover every role-specific question
with text, an explicit skip, or redaction. Only `PUBLIC_CANDIDATE` text may be retained as candidate
copy; internal/private answers are hash evidence and redacted/skipped answers retain neither text nor
a text hash. Review projections expose the typed `fieldPath`, public-only structured candidate
summary, discrepancy groups, safe timeline, and truthful handoff readiness. They remain review data,
not an approval or package mutation.

The proposal request identity is permitted by the forward-only
`20260812000000_allow_proposal_submission_identity` source-shape correction. It remains unapplied
under the database incident stop; local schema validation and migration-contract tests are not live
database evidence.

For client files, use the quarantined intake-upload contracts and actions rather than Media Lab.
Reserve the durable actor-bound request before storage signing; never accept an object key or
generation from the browser. A verification claim must remain live and exact through HEAD and
settlement, and the exact storage version belongs only in private durable evidence. Treat
`AWAITING_REVIEW` as transport verification, not format or malware verification. Do not add GET
signing, inline preview, extraction, AI dispatch, package creation, approval, apply, or publication
without the corresponding owner-approved policy and action boundary. See
`docs/quarantined-intake-uploads.md`.

## Guest structured blocks

Extend guest responses through the strict browser-safe discriminated union. Preserve legacy text and
place compatibility while validating callout, action, citation, choice, image, gallery, event, and
location blocks. Reject unknown variants. Image and map URLs are HTTPS-only and must reject
credential- or secret-like parameters. Rendering a block does not authorize fetching a private
asset or establish live availability.

## Adding an AI workload

Register a workload/model identity in `@pathfinder/ai`. Route every call through admission, budget
reservation, provider dispatch fencing, structured-output validation, and usage evidence. Freeze the
effective model and prompt identities in durable evaluation or agent records. Never call a provider
SDK from a router or UI.

Use the central workload configuration resolver for platform→workload→client→venue precedence and
preserve its effective-source result. Registry defaults, durable overrides and unavailable layers
are different states. Read APIs must use secret-free explicit output schemas and exact tenant/venue
authorization. No UI may invent an override for a layer that has no persistence.

## Evaluation dispatch and staged agents

Evaluation requests persist frozen identities as `STAGED`; routers do not enqueue them directly.
The default-off reconciler checks process, durable-global, and tenant gates, advances to `QUEUED`,
then publishes a deterministic job and republishes queued rows to repair crash gaps. Keep lifecycle
changes behind the SQL state machine and scoped CAS helpers. Retry must reuse terminal case results
and prior spend; never rebuild mutable content or silently switch models.

Long provider calls run under an exact live execution lease. Renew with the database clock and the
same tenant/venue/record/token before dispatch, periodically while awaiting the provider, and once
more before accepting its result. Pass the heartbeat `AbortSignal` to the provider gateway. If a
renewal loses ownership, abort, settle any dispatched reservation as ambiguous, and never
redispatch it. Distinguish durable user cancellation from takeover and perform no stale terminal
domain write after ownership loss.

Operational evaluation comparison accepts two runs only when frozen corpus, content/package,
model, prompt/config, manifest, case revision/hash, and result evidence are compatible. Duplicate or
off-manifest evidence is explicitly `INCOMPARABLE`. A HUMAN `PLATFORM_ADMIN` may append a conclusion
only to exact `COMPLETED` run evidence. Actor/scope/revision-bound UUID/hash replay and sanitized
audit are atomic. Comparison and conclusions are evidence, not package approval, a package gate, or
provider authority.

Agent identity configuration uses the closed contracts in `@pathfinder/contracts` and neutral DB
actions. Creation is disabled-only, edits require a disabled row and current `updatedAt`, and disable
is the only activation-related mutation exposed. Do not add enable/run/provider/credential controls
to the staged editor or infer execution authority from an approval.

## Venue Deployment Manifest v2

Validate the browser-safe FULL/PATCH contract before review. Canonical artifact bytes retain the
complete manifest, while the hash domain excludes the FULL evaluation field that would otherwise
refer to its own manifest hash. Evidence locators accept only credential-free HTTPS references or
the explicit internal schemes; signed URLs, query credentials, fragments and secret-shaped values
fail closed. PATCH operations remain stable-ID upsert/retire/reset operations and require an exact
persisted FULL artifact in the same tenant/venue scope.

The canonical service reviews under `RepeatableRead` and persists under `Serializable` with the
venue advisory lock. It can append a one-to-one immutable
`VENUE_DEPLOYMENT_MANIFEST_V2` artifact with complete deterministic section coverage and
`MATERIALIZABLE`/`NOT_MATERIALIZABLE` evidence. For the narrowly supported, lossless PATCH bridge,
artifact creation/replay, the compatibility `DRAFT`, and its artifact link finalize atomically in
the ordinary stateless draft service. FULL manifests and PATCH operations that cannot be represented
losslessly persist review evidence only and remain `NOT_MATERIALIZABLE`; they never create a legacy
draft. Recording either result does not approve, apply, publish, call a provider or authorize a
lifecycle transition. Forward-only migration `20260812000800_add_venue_package_manifest_artifacts`
remains unapplied; local schema and transaction tests are not live database evidence.

`admin.previewFullVenueDeploymentManifest` is a separate read-only projection. It requires exact
platform-admin tenant/venue scope and caller-supplied manifest/idempotency UUIDs, selects only safe
current venue configuration fields, validates the FULL v2 contract, and returns canonical JSON plus
its canonical hash. It is deliberately `NOT_READY`: current configuration is not an immutable
publication snapshot, and generalized modules, immutable assets, capability truth, model references,
and readiness evidence remain omitted. The browser download must use the returned canonical bytes
and must be invalidated whenever its UUID envelope changes or a later request fails. Do not route the
projection into `createDraft`, apply, persistence, or a queue.

## Explicit generalized-content publication

Authoring audience `PUBLIC` does not publish a generalized module. Publication and withdrawal append
an event to the exact tenant/venue/module ledger under the venue content lock. Publish requires the
selected revision to remain the latest expected version and have `PUBLIC` audience; withdrawal
requires the exact currently published revision. Reuse a UUID only for the identical actor/action
identity, keep strict audit in the same transaction, and treat collisions or changed revisions as
conflicts.

The guest resolver consumes only the latest effective published Service, Policy, Event, Operational
Fact, and Relationship revisions. Keep its tenant/venue scope, 100-module maximum, 500-event history
ceiling, effective-time filtering, explicit typed payload selects, and stable kind/module ordering.
It remains behind `generalizedContentCapabilities`; resolver failure returns no generalized modules
rather than exposing draft/internal content. The additive publication migration is unapplied, so
local tests are not evidence of a live guest path.

## Search, retention and external surfaces

Unified admin search must remain authorized, bounded, grouped and based on explicit safe selects.
Results are navigation hints, not mutation or audit evidence. Retention helpers are a fail-closed
policy registry only: no deletion or anonymization may be added before owner/legal policy. Partner
API, MCP transport, SDK and provider execution remain default-off and must not acquire an accidental
listener or authentication path through a read-only UI. The external-credential persistence seam is
dark metadata only: credentials default disabled and retain an Argon2id hash plus non-secret prefix,
exact tenant/client/optional venue scope, capabilities, and append-only rotation/revocation evidence.
It deliberately exposes no plaintext secret, issuance, verification, enablement, rotation,
revocation mutation, transport listener, or request authentication.

The MCP read adapter is a canonical, transport-neutral binding over verified invocation context.
Every query must reapply exact tenant/client/venue scope, use a bounded resource-specific cursor and
positive safe selects, then pass output leakage filtering. Raw job/package payloads, internal support
messages, snapshots, errors, signed asset/source URLs, redirects, and secrets remain excluded.

## Schema and migrations

Guest chat turns use a client `operationId` UUID and a versioned canonical request hash bound to the
exact tenant, venue, anonymous session actor, normalized message, language, visitor identity,
coordinates and effective location-retention policy. Reservation assigns monotonic turn and message
sequences plus stable embedding and generation invocation receipts before provider work. Claiming
requires the exact two pristine receipts. Once either provider boundary is durably dispatched it is
never dispatched again for that operation; expired dispatched or observed-but-unfinalized work is
reconciled to a terminal ambiguous result, while proven pre-dispatch orphans are failed safely.

Provider calls remain outside database transactions. The final serializable transaction writes the
ordered user/assistant pair, engagement answer, next pending-question state, session counters and
schema-validated replay evidence before completing the turn. Exact terminal replay reconstructs the
safe response from committed messages without provider or spend work. History orders by the durable
session sequence rather than wall-clock timestamps. Public analytics accepts the legacy browser
token field only as a lookup credential: the server resolves the exact tenant/venue session and
persists its internal ID, never the bearer token.

New analytics events may carry an exact internal user-message foreign key. Structural metadata must
not copy raw guest questions as fallback. Enrichment reads transient text only through the scoped
relation to a `user` message and skips unattributed legacy events.

Admin answer-analysis and chatlog-review adapters are transport-thin. Durable analysis identity is
operation-scoped by tenant, kind and UUID; snapshot, dispatch and sanitized audit commit together,
then queue notification is best effort. Chatlog notes bind a UUID to exact tenant/venue/session,
actor and normalized note content. General audit records only the note length; it never copies the
private note body.

Global AI control writes also belong to a neutral action. Require a HUMAN platform administrator,
trim and bound the internal reason, validate the expected revision before opening durable work,
compare/update by exact `updatedAt`, replay an identical state without a second audit, and repair a
malformed row only through an explicit fail-closed write. The state change and strict audit share one
transaction. The action never calls a provider; admission readers remain responsible for denying a
paused, malformed, or unavailable control.

Weekly-digest queue publication must follow durable intent. The neutral action accepts a HUMAN
platform administrator or only the identified `weekly-digest-scheduler` SYSTEM actor, validates an
ordered tenant/week range, creates/replays the natural-key row, and CAS-resets `FAILED` to `PENDING`
with strict audit. Do not enqueue `PROCESSING` or `COMPLETE`. Queue publication uses the digest ID as
deterministic identity, removes a retained failed job before redrive, and confirms concurrent queue
state after add races. These contracts do not prove a live scheduler, Redis, worker, or provider.

Offboarding draft creation uses a tenant-scoped UUID request identity and a lowercase SHA-256 hash of
canonical planning input (sorted venue, revocation-target and export-kind arrays plus normalized
effective time). The canonical action serializes the tenant/request pair, replays only the same hash
and requesting actor, and writes no second audit event. The additive migration refuses to invent
identity for unexpected historical plans; the original foundation is still unapplied under the
database incident stop.

Use additive, forward-only migrations with exact tenant/venue composite keys, lifecycle checks, and
append-only guards where evidence is immutable. Add static migration-contract tests. During the
active incident stop, do not inspect, apply, rollback, seed, or rehearse against an external database.
When SQL names differ from Prisma field names, preserve the mapping explicitly with `@map` or
`map:`. Review dependent migrations as a chain for ordering, enums, relation names, composite
foreign keys, cascade behavior, indexes, exact scope, and append-only triggers. Offline
format/validate/generate may use a syntactically valid dummy loopback URL; it is not permission to
connect or evidence that any migration was applied.

The forward-only `20260812000400_add_durable_guest_chat_turns` migration adds the turn/receipt state
machines, composite session/message/analytics scope, sequence backfill, legacy analytics-token
resolution, role and pending-state constraints, and terminal immutability guards. It is intentionally
unapplied; local contract tests and loopback Prisma validation are not live migration evidence.

The forward-only `20260812000500_support_requester_isolation` migration backfills and then guards the
immutable requester membership, adds append-only grant/revocation evidence for explicit participants,
and separates client-visible version/activity from global operator history. It rejects unresolved
historical client requesters rather than inventing identity. It is intentionally unapplied; schema,
migration-contract, domain, API, UI and static checks remain local evidence only.

The forward-only `20260812000600_evaluation_review_commands` migration adds paired nullable command
UUID/hash columns for historical compatibility and tenant-scoped uniqueness for new review
commands. It invents no historical values and is intentionally unapplied; local checks are not live
database evidence.

The forward-only `20260812000700_add_analytics_user_message_attribution` migration adds the exact
session-scoped user-message relationship and role guard while leaving historical events nullable.
It is intentionally unapplied; focused schema/helper/analytics/worker checks are local evidence.

The forward-only `20260812000900_add_support_message_request_version` migration adds nullable
immutable produced-request-version evidence to Support messages. Legacy messages are not guessed or
backfilled; manual-loop replay requires the evidence and fails closed when it is absent. It is
intentionally unapplied, so local schema, migration and replay tests are not live database evidence.

Client Weekly Reports routes are capability projections, not an enablement surface. Resolve exact
authorized report availability on the server; show navigation only when at least one authorized
venue is enabled, and hide it when the availability read fails. List/detail routes read published
safe projections only, preserve exact venue scope, reject disabled venues before report reads, map
scoped missing detail to not-found, and recover malformed bounded cursors to the newest page with a
plain status. This does not prove a scheduler, provider, delivery channel or live report lifecycle.

## Required verification

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`, followed by the repository security
verifiers for raw SQL, tenant bypasses/procedures/registry, AI provider/budget boundaries, public
surfaces, Docker context, and browser bundle secrets. Runtime, browser, staging, migration, restore,
and promotion claims require evidence from the correctly authorized isolated environment.

For continuation reporting, link focused checks to the applicable row in
`docs/packet-2-traceability-matrix.md`. Use `implemented-foundation` only for the bounded cited slice,
`partial` when packet outcomes remain, and `live-unverified` whenever local evidence has not been
reproduced in an authorized runtime. Do not roll historical full-suite counts forward as if they
covered concurrent changes.

## Client creation and Clerk reconciliation

Provider-backed client creation is fenced by a durable `requestId` before the Clerk call. The
request hash binds the client and initial-venue input without persisting email addresses, content,
or credentials. Once the intent records `PROVIDER_STARTED`, an unconfirmed provider result must not
be retried automatically. A platform administrator must use the reconciliation mutation with the
same request and a verified Clerk organization ID; the original create call can then finish local
tenant, owner, venue, and audit persistence idempotently.

Clerk membership validation is authoritative at the instant it is read, but it cannot make the
subsequent local transaction atomic with Clerk. Reconciliation therefore revalidates the selected
user's owner-equivalent Clerk membership and email before claiming the organization. Later Clerk
membership changes remain the responsibility of the existing webhook/membership reconciliation
path; local creation never assumes that an earlier validation is permanently authoritative.
