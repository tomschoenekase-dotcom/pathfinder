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

Operational updates are another canonical-action reference: HUMAN manager/owner authorization,
exact tenant/venue/place scope, content-version entity and capacity locks, expected `updatedAt` CAS,
bounded overlap validation, and required audit in one transaction. API adapters validate and
authorize before calling the helper; they must not recreate mutations in route code. Intake
proposal creation, listing, and existing-`DRAFT` package linkage similarly live in the neutral DB
service so tenant and admin adapters share the same scope, privacy, lineage, and audit rules.

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

VenuePackage lifecycle transition authority is neutral and shared: HUMAN `OWNER`, exact
tenant/venue/package, venue lock, command replay/collision, CAS, content-version context, and strict
audit. The compatibility router still owns V1/V2/V3 effect orchestration inside the same outer
transaction; do not split effects from final transition or replace legacy rollback with V3 rules.
Weekly-report configuration/edit/publish actions are similarly neutral, but generation dispatch is
an orchestration concern and must reject an inverted range before any transaction. Client creation
uses a durable pre-provider intent: commit `PROVIDER_STARTED` before Clerk I/O, block ambiguous retry,
and reconcile only after revalidating the exact organization, owner-equivalent membership, and email.
The intent/event migration enforces its state machine and append-only evidence; it remains unapplied.

## Adding an intake adapter

Implement the adapter interface in `@pathfinder/intake-engine`. Bound time, size, count, evidence,
cost, redirects, and cancellation. Preserve citations and privacy classes. Unsupported sources must
return `NOT_CONFIGURED`. The adapter may produce a draft proposal but cannot approve or apply it.
Persist proposals and package links through the neutral `packages/db` intake action. Candidate
content must contain only material authorized for that audience; keep withheld input as manifest or
hash evidence. Package linkage is exact-scope, append-only, and existing-`DRAFT` only, and has no
create, approve, apply, or publish side effect.

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

Agent identity configuration uses the closed contracts in `@pathfinder/contracts` and neutral DB
actions. Creation is disabled-only, edits require a disabled row and current `updatedAt`, and disable
is the only activation-related mutation exposed. Do not add enable/run/provider/credential controls
to the staged editor or infer execution authority from an approval.

## Venue Deployment Manifest v2

Validate and canonically hash the browser-safe manifest contract before conversion. PATCH operations
must remain stable-ID upsert/retire/reset operations; do not reintroduce monolithic content
replacement. The current API bridge is a pure conversion/review seam that returns exact legacy
VenuePackage preview/draft inputs. Calling preview or createDraft remains an explicit, separately
authorized lifecycle action; review itself is non-mutating.

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

Use additive, forward-only migrations with exact tenant/venue composite keys, lifecycle checks, and
append-only guards where evidence is immutable. Add static migration-contract tests. During the
active incident stop, do not inspect, apply, rollback, seed, or rehearse against an external database.
When SQL names differ from Prisma field names, preserve the mapping explicitly with `@map` or
`map:`. Review dependent migrations as a chain for ordering, enums, relation names, composite
foreign keys, cascade behavior, indexes, exact scope, and append-only triggers. Offline
format/validate/generate may use a syntactically valid dummy loopback URL; it is not permission to
connect or evidence that any migration was applied.

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
