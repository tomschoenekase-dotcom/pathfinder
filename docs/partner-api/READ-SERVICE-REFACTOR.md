# Partner API shared read service refactor proposal

Status: design proposal only. No read service, HTTP route, credential, entitlement, or
hosted configuration is changed by this document. Packet 4's stop condition applies: resolve
the shared-read boundary before implementing partner domain actions that would duplicate reads.

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
4. **Guide projection has no implementation in the partner registry.** The packet asks for guide
   URLs and theme tokens, while existing distribution docs describe URL generation and the app
   host guide separately. Build a narrow projection by composing the existing distribution URL
   builder and public appearance normalization, not by serializing the MCP `configuration` result.
   Return only canonical URLs and an allowlisted theme shape; never expose private configuration,
   prompt settings, or internal origin policy.
5. **Door entitlement is ambiguous.** Product capability IDs include `app-webview` and `api`,
   while the distribution runbook says the app surface requires the `app-webview` entitlement,
   an active venue, global app gate, and enabled app state. Packet 4 separately requires a partner
   API capability/key and asks for URLs “for each door the client is actually entitled to.” The
   current partner contract has capabilities but no product-entitlement or per-door field. Do not
   infer that a partner key grants `app-webview`, or that `api` grants guide access. Before coding
   the guide response, define whether guide URL visibility follows the current app distribution
   resolver per venue, another explicitly named entitlement, or is omitted while unavailable. The
   credential must never bypass the public guide's own runtime gates.
6. **Credential and admin assumptions differ from R1.1.** The `pf_read_` Argon2 lifecycle and
   generic page mean the packet's “no key creation/dashboard” statements cannot be followed
   literally without a source check. Pick one reviewed storage/verifier lifecycle, document how
   legacy credentials remain excluded from new HTTP auth, and avoid duplicating the admin surface.
7. **The route list and operation catalog differ.** The packet's HTTP endpoint list names client,
   venues, venue detail, content, updates, and guide. The contract/catalog has configuration and
   readiness but no venue detail or guide operation. Decide whether HTTP detail maps to an existing
   operation, and whether configuration/readiness are exposed as routes. Update contract, registry,
   generated OpenAPI, tests, and guide together so no undocumented or unreachable operation is
   implied. Keep the API dark while deciding.

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
validated. For approved content, updates, and guide projection, write down partner visibility
semantics first and keep them distinct where MCP's current behavior is broader.

## Suggested implementation order and proof

1. Agree the HTTP-to-operation mapping and the entitlement answer for guide URLs. Keep global
   `partnerReadApi` default-off and add no live key or hosted configuration.
2. Add shared service contracts and focused tests for cross-tenant/client scope, cursor stability,
   mixed content pagination, update visibility/time boundaries, guide field allowlisting, and
   entitlement denial. Prefer disposable database tests for query semantics.
3. Extract only the reusable MCP reads needed by the partner surface, then verify MCP behavior and
   partner results independently. Do not have the partner adapter call `readMcpResource`.
4. Bind the partner registry to the services, then add transport and OpenAPI only after the route
   catalog is made consistent.

Until those decisions and service tests exist, M3/M4 remain unimplemented. This proposal is not
evidence of a working endpoint, guide URL, entitlement check, or hosted enablement.
