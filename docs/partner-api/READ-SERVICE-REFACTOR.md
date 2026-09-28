# Partner API shared read service refactor proposal

Status: route/catalog and guide-door decision, with executable contract tests. Route bindings and
the guide DTO are recorded in `packages/contracts/src/partner-read-api.ts`; the pure URL/allowlist
projection is covered by `packages/api/src/partner-api/guide-projection.test.ts`. No canonical
Prisma read, HTTP listener, credential, hosted configuration, or enablement is added. Packet 4's
stop condition still applies to domain read bindings until the shared-read boundary is implemented.

## R1.1 source correction: credentials and admin UI already exist

The older Packet 4 premise that there is no partner key lifecycle or dashboard surface is stale on
R1.1. The existing `ExternalAccessCredential` actions support `PARTNER_READ_API` credentials with
`pf_read_` secrets, Argon2id verifiers, and disabled-by-default issuance; the generic admin
credentials page already lists the partner credential kind. This is lifecycle and UI groundwork,
not proof of a partner HTTP route or active access. Reuse or extend these seams only after comparing
their scope, verification, and lifecycle semantics with Packet 4's proposed `tk_<env>_<publicId>_
<secret>` HMAC design.

Do not let a legacy `pf_read_` secret authenticate the new v1 HTTP route by accident or by a
fallback branch. If the new HMAC format and legacy Argon2 format remain distinct, define explicit
prefix/version dispatch, test that each verifier accepts only its own format, and keep legacy
credentials unable to authorize partner HTTP until a separately reviewed migration decision says
otherwise. The separate `PartnerApiCredential` table proposed in the old packet could duplicate
storage, lifecycle actions, audit behavior, and admin UI. Compare both approaches before adding a
second model or a second key-management page. Extend the existing generic credentials UI if its
permissions and one-time-secret behavior meet the required partner workflow; avoid a competing
page without a concrete gap.

Any admin UI work must follow the current v2 brand system. A v1 visual in an older packet is not a
current design reference.

## Architecture decision and current status

Keep the proposed `tk_<env>_<publicId>_<secret>` credential contract separate for the future v1
HTTP API. It carries an explicit environment and public lookup ID, scopes one client credential to
an explicit set of venues and capabilities, and is designed for an overlap rotation period. The
existing `pf_read_` `ExternalAccessCredential` path uses an Argon2id verifier, represents one
nullable venue scope (or client scope), and rotation immediately revokes the old credential while
creating its replacement disabled. Those lifecycle and scope semantics do not implement the
environment-tagged, multi-venue, overlap contract. Keeping the formats separate also prevents the
HTTP verifier from treating an existing MCP/partner credential as authority by prefix fallback.

The new HMAC credential service remains dark: it is not wired to an HTTP authentication route or
dashboard issuance flow. Existing `pf_read_` credentials remain excluded from v1 HTTP
authentication. The local schema, migration, and service work in this packet is not authorization
to apply a migration or enable credentials in any hosted environment; no rollout or enablement
decision is implied.

The M2 verifier currently has one injected pepper, with no pepper version on a credential row.
Changing that pepper therefore invalidates every extant `tk_` key. Until versioned verifier keys
and a reviewed keyring migration exist, treat pepper replacement as a deliberate mass-reissue
event and keep this credential path dark. Ordinary credential rotation preserves the source expiry
unless a new future expiry is explicitly supplied; revoked or expired source credentials cannot
be rotated. A separate create operation is needed after expiry.

M1/M2 are partial in the local worktree: the additive model/migration and HMAC lifecycle code exist,
but their full acceptance proof and dashboard integration are incomplete. M3/M4 are blocked pending
the shared canonical-read boundary and guide/entitlement decisions in this proposal; no bound HTTP
read actions or guide endpoint are claimed.

## Why stop here

The partner contract and registry define six operations (`clients.get`, `venues.list`,
`approved-content.list`, `configuration.get`, `readiness.get`, and `updates.list`). The registry
correctly requires injected domain actions and does not query Prisma. There is no concrete partner
action binding yet.

The concrete MCP bindings in `packages/api/src/mcp/read-actions.ts` are not directly reusable as
partner DTOs: they accept MCP resource inputs, use MCP cursor encoding, and return broad internal
read results. They also query Prisma in the MCP adapter itself. Reimplementing those queries in
the partner route would create a second source of truth for filtering and pagination, while calling
the MCP API internally would couple one transport adapter to another and risk exposing fields
selected for MCP rather than partners.

## Observed contract and implementation gaps

1. **Venue pagination is not a client venue listing today.** The MCP `venues` resource requires a
   `venueId` and `readVenues` filters by that exact ID. The partner contract's `venues.list` takes
   only `clientId` and supports a cursor and limit. A shared service must list all eligible venues
   for the authenticated tenant/client scope, enforce that binding, and use deterministic
   cursor pagination. It must not accept a caller-supplied tenant ID.
2. **Partner updates need a distinct public filter.** The MCP `readUpdates` selects operational
   update fields including body, status, active flag, publication time, and expiration, but its
   query filters only by tenant and venue and orders by creation time. The partner operation is
   described as published or scheduled/partner-visible. Define precisely which statuses and time
   windows qualify, whether scheduled items are visible before `startsAt`, and what content fields
   are safe. Apply that predicate in one shared service and test its boundaries; do not expose
   arbitrary operational records just because the credential has `updates:read`.
3. **Approved content needs one stable page across two tables.** MCP reads active places and enabled
   knowledge entries independently, takes `limit + 1` from each, merges in memory, then paginates
   by `createdAt` and `id`. A partner cursor cannot safely inherit the MCP cursor unchanged: IDs
   can collide across entity types, the combined ordering needs a type tie-breaker, and advancing
   across two tables must not skip or repeat rows. Establish a single ordering tuple and opaque,
   versioned cursor over `(createdAt, contentKind, id)` (or another stable unique key), with bounded
   database reads and a documented snapshot-consistency expectation.
4. **Guide projection is narrowly defined.** Packet 4's partner use case is opening the guide in
   an app WebView, so `guide.get` exposes only the app WebView door. It returns canonical app and
   compact-app URLs plus the validated `appBackground` token required by the current App WebView
   host guide. It never serializes MCP configuration, private settings, or internal origin policy.
5. **Guide entitlement follows the existing distribution resolver.** The domain action must call
   `resolveVenueDistribution` for the exact credential-scoped venue and return a projection only
   when `app.effective` is true. That resolver composes the global app flag, active venue,
   `app-webview` product entitlement, and enabled app state. Neither the partner key nor its
   `configuration:read` capability grants these. If the resolver denies access, return no guide
   projection (mapped to not-found) and do not recreate or bypass the public guide gates. Website,
   QR, and direct doors are excluded from this WebView operation; adding another door needs a
   separate contract decision.
6. **Credential and admin assumptions differ from R1.1.** The `pf_read_` Argon2 lifecycle and
   generic page mean the packet's “no key creation/dashboard” statements cannot be followed
   literally without a source check. Pick one reviewed storage/verifier lifecycle, document how
   legacy credentials remain excluded from new HTTP auth, and avoid duplicating the admin surface.
7. **HTTP routes map explicitly to operations.** `PARTNER_HTTP_ROUTE_BINDINGS` is a declarative
   route catalog; no HTTP router consumes it yet. Catalog validation enforces unique routes and
   exactly one planned route for every operation:

   | HTTP route                                           | Operation               | Capability              |
   | ---------------------------------------------------- | ----------------------- | ----------------------- |
   | `GET /api/partner/v1/client`                         | `clients.get`           | `clients:read`          |
   | `GET /api/partner/v1/venues`                         | `venues.list`           | `venues:read`           |
   | `GET /api/partner/v1/venues/{venueId}`               | `venues.get` (added)    | `venues:read`           |
   | `GET /api/partner/v1/venues/{venueId}/content`       | `approved-content.list` | `approved-content:read` |
   | `GET /api/partner/v1/venues/{venueId}/configuration` | `configuration.get`     | `configuration:read`    |
   | `GET /api/partner/v1/venues/{venueId}/guide`         | `guide.get` (added)     | `configuration:read`    |
   | `GET /api/partner/v1/venues/{venueId}/readiness`     | `readiness.get`         | `readiness:read`        |
   | `GET /api/partner/v1/venues/{venueId}/updates`       | `updates.list`          | `updates:read`          |

   Configuration and readiness routes expose existing catalog operations and satisfy the
   objective's explicit promise to read readiness. `guide.get` stays separate from configuration
   because it has a narrower output and app-entitlement gate; it reuses `configuration:read` and
   adds no new key capability. The new `venues.get` and `guide.get` domain actions remain injected
   and introduce no Prisma reads. Contract and registry tests prove this planned map and its
   capability boundary. Before the guide action is bound, compare its exact output URLs with
   `projectPartnerGuide` built from the configured web origin and the credential-scoped venue's
   canonical slug/distribution readback. The current strict DTO checks shape and HTTPS, not that
   an arbitrary HTTPS host is Torchiko's configured origin; no partner caller can reach it yet.

## Proposed boundary

Extract small, transport-neutral read services under `packages/api/src/partner-api` or a shared
`packages/api/src/read-services` module, with explicit input scope and output DTOs. The services
should accept a server-established `{ tenantId, clientId, venueIds }` scope, a bounded pagination
request where applicable, and the database/service dependencies they need. They must not accept
scope authority from request JSON. Keep the partner registry responsible for capability checks,
credential revalidation, rate limits, and audit. Keep HTTP responsible for bearer parsing,
transport status/headers, and request validation. Keep the read service responsible for tenant and
client predicates, visibility filters, stable pagination, and data minimization.

The MCP adapter can adopt extracted functions only where the semantics match exactly. Preserve its
existing MCP response shape and cursor contract via a thin mapper; do not silently narrow or broaden
MCP behavior as a side effect. Partner output types should be separately allowlisted and contract
validated. For approved content and updates, keep partner visibility semantics distinct where MCP's
current behavior is broader. The guide action must compose `resolveVenueDistribution`,
`buildVenueAccessArtifacts`, and the existing public theme projection. `packages/api` must not query
Prisma directly or import app-only presentation code for this response.

## Suggested implementation order and proof

1. Extract the shared read boundary for tenant/client venue scope, stable partner content
   pagination, partner-visible update filtering, and partner-safe projections. Keep global
   `partnerReadApi` default-off and add no live key or hosted configuration.
2. Add focused tests for cross-tenant/client scope, cursor stability,
   mixed content pagination, update visibility/time boundaries, guide field allowlisting, and
   entitlement denial. Prefer disposable database tests for query semantics.
3. Extract only the reusable MCP reads needed by the partner surface, then verify MCP behavior and
   partner results independently. Do not have the partner adapter call `readMcpResource`.
4. Bind the partner registry to the services, then add transport and OpenAPI only after the route
   catalog is made consistent.

Until those decisions and service tests exist, M3/M4 remain unimplemented. This proposal is not
evidence of a working endpoint, guide URL, entitlement check, or hosted enablement.
