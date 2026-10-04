# Live Data Connectors and the Open-Web Policy (Packet W10)

Status: implemented and fixture-tested. No real partner or provider connectivity is claimed.

## Owner decisions this implements

1. No unrestricted visitor web browsing by default.
2. Approved static knowledge reaches the guide through the existing content pipeline (places, knowledge entries, published universal content). Nothing in this packet adds a second static path.
3. Venue-approved, read-only live data (game score, period, clock; ride wait time; ride open or down) arrives through one generic adapter contract, not a bespoke integration per client.

Customer-facing wording (rendered in the dashboard and exported as `GUEST_KNOWLEDGE_POLICY_WORDING`):

> The guide does not freely browse the public web; it uses approved venue information and configured live sources.

## Survey: what already existed

| Finding                                                                                                                                                                                                                                                                                                                                                                                                 | Where                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest chat builds its model context from retrieved places, knowledge entries, active alerts and published content, escaped as untrusted data                                                                                                                                                                                                                                                            | `packages/api/src/lib/venue-context.ts` (`buildVenueSystemPromptParts`), called from `packages/api/src/routers/chat.ts`                                                                                   |
| An allowlisted, dark-by-default "general background" search already exists. It needs the platform flag `GUEST_GENERAL_WEB_FALLBACK_ENABLED`, a per-tenant feature flag `guest-general-web-fallback-v1` naming the venue and a domain allowlist (1 to 20 public domains), and a venue with guest links on. It is single-call, domain-restricted, never venue authority. It is **not** open-web browsing. | `packages/api/src/routers/chat.ts` (the one `searchGuestWebWithAccounting` call site), `lib/guest-general-web-policy.ts`, `lib/guest-general-web-configuration.ts`, `packages/ai/src/guest-web-search.ts` |
| When that fallback is off, the system prompt tells the model it has no web access and that a visitor request does not grant one                                                                                                                                                                                                                                                                         | `venue-context.ts`, the `WEB AVAILABILITY` rule                                                                                                                                                           |
| An SSRF-aware fetcher existed only inside the API (website intake). Workers cannot import `@pathfinder/api`, so it could not be reused                                                                                                                                                                                                                                                                  | `packages/api/src/lib/website-intake-runtime.ts` (`pinnedFetch`)                                                                                                                                          |
| Static public-URL guard (no DNS)                                                                                                                                                                                                                                                                                                                                                                        | `packages/api/src/operator/kinds/public-url.ts`                                                                                                                                                           |
| Reviewed route-handler boundaries are limited to tRPC mounting, Clerk webhooks, health, admin impersonation                                                                                                                                                                                                                                                                                             | `CLAUDE.md` API Rules                                                                                                                                                                                     |
| Worker conventions: queue and job constants, payload types, enqueue helper, processor with `JobRecord`, scheduler registration                                                                                                                                                                                                                                                                          | `packages/jobs/src/*`, `apps/workers/src/index.ts`                                                                                                                                                        |
| Existing guest-tuning settings page that already switches between venues                                                                                                                                                                                                                                                                                                                                | dashboard `ai-controls` ("Guide tone and answers")                                                                                                                                                        |

There was no tool-use, browse or fetch capability in the guest answer path other than the gated fallback above, and no connector, integration or webhook framework for live data.

## The three concepts operators can inspect

`liveData.policy({ venueId })` (any tenant role) returns a read-only `GuestKnowledgePolicy`:

| Concept           | Value                                                                       | Meaning                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General knowledge | `APPROVED_VENUE_ONLY` (default) or `ALLOWLISTED_GENERAL_BACKGROUND`         | The second is the pre-existing fallback, reported, never widened. It is derived from server flags and the tenant grant, so it cannot be set here.                                     |
| Open web          | `{ enabled: false, enablement: 'PLATFORM_ADMIN_ONLY', implemented: false }` | A constant. There is no field, flag, header, query value or document text that can change it. Enabling it would need a platform admin **and** a browsing product that does not exist. |
| Live connectors   | `{ activeCount, totalCount }`                                               | Venue-approved read-only feeds described below.                                                                                                                                       |

Proof of the "cannot browse regardless of content" claim (`packages/api/src/lib/guest-knowledge-policy.test.ts` and `routers/chat.test.ts`):

- the decision function returns SKIP for hostile messages (search or browse requests, URLs, "enable web", `openWeb=true`, instruction-override text) at every combination of server flags, including all grants present;
- hostile knowledge-entry text and a hostile query string reach the chat path and still produce zero search calls and no tenant-flag lookup;
- the chat input schema is strict and rejects `openWeb`, `webSearch`, `browse`, `tools`, `allowedDomains`;
- hostile tenant flag metadata (`openWeb: true`, wildcard domain) grants nothing;
- a source test pins exactly one guest search call site, behind the platform flag and tenant grant, fed only by the server-resolved allowlist.

## Live data model

### Contract

One generic adapter contract (`packages/contracts/src/live-data.ts`). A connector has:

- `kind`: `sports_score`, `ride_status` or `generic_json`;
- a venue-scoped `resourceId` (unique per venue) and operator `resourceLabel`;
- an HTTPS `endpointUrl` and a `mapping`: JSON pointers (RFC 6901) to typed fields (`integer`, `number`, `text`, `boolean`, `status`), plus an optional provider timestamp pointer and format (`iso8601`, `epoch_seconds`, `epoch_ms`);
- `pollIntervalSeconds` (15 to 3600), `freshnessBudgetSeconds` (at least the poll interval, up to 86400), `timezone`.

Required fields per kind: `sports_score` needs `homeScore` and `awayScore` (optional `period`, `clock`, `status`, `homeTeam`, `awayTeam`); `ride_status` needs `status` (optional `waitMinutes`); `generic_json` needs at least one field.

Normalized result (`LiveDataResult`): `{ venueId, resourceId, resourceLabel, provider, kind, values, observedAt (provider), fetchedAt (Torchiko), timezone, freshnessBudgetSeconds, state, errorCategory, conflicts }`. `values` entries are `{ type, value, unit? }`. A `null` value means MISSING; zero, `false`, `closed` and `down` are real readings and are never null.

Error categories: `host_not_allowed`, `blocked_address`, `dns_failure`, `timeout`, `network_error`, `http_error`, `redirect_blocked`, `payload_too_large`, `invalid_json`, `schema_invalid`, `missing_field`, `invalid_timestamp`, `rate_limited`.

### Storage (migration `20261002090000_add_live_data_connectors`)

Forward-only, additive, two tables, both registered in `TENANTED_TABLES`:

- `live_data_connectors` (`LiveDataConnector`): configuration, `state` (`ACTIVE` or `DISABLED`, default `DISABLED`), schedule (`next_poll_at`), health (`last_attempt_at`, `last_success_at`, `last_error_category`, `consecutive_failures`) and the last operator test. Composite FK `(venue_id, tenant_id)` to `venues`. Unique `(tenant_id, venue_id, resource_id)`. CHECK constraints bound the poll interval and freshness budget. No cascade deletes.
- `live_data_observations` (`LiveDataObservation`): the **latest** observation per connector (unique `connector_id`), with typed `values`, provider `observed_at`, `fetched_at`, `timestamp_basis` (`provider`, `fetched` or `invalid`) and `conflicts`.

No credential is stored. Connectors carry no secret, so nothing secret exists to send to the browser; the operator DTO is built from an explicit `select`.

### Data flow

```
operator (MANAGER+)        packages/api liveData router            Postgres
  create/update/enable ---> Zod, endpoint + mapping validation ---> live_data_connectors (+ audit log)
  test -------------------> enqueueLiveDataPoll(mode=test) -------> BullMQ live-data-poll queue

apps/workers (scheduler every 15 s, WORKER_SCHEDULERS_ENABLED)
  listDueLiveDataConnectors  (one reviewed bypass: opaque IDs only)
  -> per-tenant (10) and per-host (5) caps, 50 per tick
  -> enqueueLiveDataPoll(mode=scheduled), job id bucketed per connector per 15 s

apps/workers (processor: JobRecord written and updated)
  reload connector by exact tenant+venue+connector  -> not found: stop (cross-tenant ID is inert)
  scheduled: state must be ACTIVE, then claim the next slot atomically (no provider call otherwise)
  fetch (SSRF-hardened) -> normalize against the mapping -> store latest observation
  failure: record category, exponential backoff (interval x 2^n, cap 15 min), keep last good row
  test: store a preview on the connector, never an observation

guest turn (packages/api chat router)
  one read of ACTIVE connectors + their stored observation for the exact tenant+venue
  -> freshness evaluated at read time -> labelled prompt section (no provider call, ever)
```

Because freshness is computed at read time from stored timestamps, an observation can never remain "fresh" after its budget lapses even if the worker stops.

### Freshness rules

State is computed by `evaluateLiveDataState`:

| State         | Condition                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh`       | Our last successful fetch and the provider timestamp (when mapped) are both within the budget                                                 |
| `stale`       | Provider timestamp older than the budget even though our fetch was recent, **or** our fetch is older than the budget with no recorded failure |
| `unavailable` | Our last successful fetch is older than the budget and the connector is currently failing                                                     |
| `unknown`     | No observation yet, a mapped provider timestamp that is unparsable or future-dated beyond a 2 minute skew, or an unrecognized stored shape    |

If no provider timestamp is mapped, fetch time is the basis and the as-of time is our retrieval time. Recommendation in the setup guide below is to always map a provider timestamp.

### What the guide is told

`renderLiveDataPrompt` is the only path from provider data to the model. It adds a `LIVE VENUE DATA` section to the **dynamic** prompt (never the cached static instructions), after the existing untrusted-data end marker:

- `fresh`: the values and an "as of" time in the venue time zone, for example `{"source":"Skyline Coaster","status":"FRESH","asOf":"Oct 2, 2026, 2:00 PM","values":{"status":"open","waitMinutes":"0 minutes"}}`;
- `stale`, `unavailable`, `unknown`: `NOT_CURRENTLY_AVAILABLE` and **no values at all**, so an old number cannot be quoted. Rules tell the model to say the information is not currently available and never to guess;
- rules also state that 0, "closed" and "down" are real readings and `MISSING` means that one value is unknown;
- a ride whose status is `down` or `closed` has any reported wait dropped and flagged `wait_ignored_while_not_open` (conflicting provider data).

Provider text cannot instruct the model: statuses are mapped into a closed vocabulary (anything unmapped is `unknown`); numbers are parsed and range-checked; free text is limited to 40 characters, control characters are rejected, and instruction-like text (override phrases, role markers, tags, URLs) is dropped and treated as missing; every line is JSON-encoded, escaped (`< > &`) and framed inside `<untrusted_live_data>`; operator labels are escaped too. A read failure on the guest path degrades to "no live section" without failing the turn.

## Security controls

- **Tenant isolation.** Both tables are tenanted. Every router query carries `tenantId` from the session, never input; inputs are strict Zod objects that reject a `tenantId`. Cross-tenant connector IDs return NOT_FOUND and change nothing (tested). Every new `tenantProcedure` has a generated cross-tenant case in `packages/api/src/testing/tenant-procedure-cases.json` (124 procedures verified).
- **One reviewed bypass.** `packages/db/src/helpers/live-data.ts` uses `withTenantIsolationBypass` once, only to list opaque due IDs. The poll job re-enters exact tenant, venue and connector scope. The boundary script pins the new count (`scripts/verify-tenant-bypass-boundary.mjs`); this needs the security review the repository policy requires.
- **Roles.** Reads: any tenant role. create, update, enable, disable, test: MANAGER or stricter, server-side.
- **Audit.** `live-data-connector.created|updated|enabled|disabled|test-requested`, written in the same transaction as the state change. Audit state records the host, never the full URL or any provider data.
- **SSRF.** Static checks (https, port 443, no embedded credentials, no secret-looking query keys, no IP literals, no internal names) at create, update and fetch time; platform host allowlist `LIVE_DATA_ALLOWED_HOSTS` (exact hosts or `*.example.com`) that **fails closed in production when unset**; the host is resolved by the worker and every returned address must be globally routable (loopback, RFC1918, CGNAT, link-local including `169.254.169.254`, multicast, documentation and mapped or embedded IPv4 private ranges are refused); the socket is pinned to the validated address with SNI and Host preserved, defeating DNS rebinding; redirects are manual, at most 2, each re-validated through the same checks.
- **Limits.** 5 s request timeout, 64 KiB payload ceiling (declared and streamed), JSON only, 12 fields per connector, 20 connectors per venue and 100 per tenant, test fetch cooldown 30 s per connector, scheduler caps per tenant and per provider host, at most one retry inside a poll plus exponential backoff across polls.
- **Secrets.** None stored or logged. Worker logs carry IDs, mode and error category only (tested: no endpoint, no payload text).
- **Disable.** `disable` sets `DISABLED` and clears the schedule in one audited transaction. Scheduled jobs for a disabled connector exit before any network call, a connector disabled mid-fetch discards the result, and the guest read ignores non-`ACTIVE` connectors.

## How a customer sets up a feed

Operator, in the dashboard under **Guide tone and answers** then **What the guide may use, and live feeds** (manager or owner role):

1. Torchiko adds the provider's host to `LIVE_DATA_ALLOWED_HOSTS` for the environment (required in production).
2. Choose the venue, then **Add a live source**: kind, a name, provider, what visitors call it, a stable resource ID such as `game.home` or `ride.coaster`, the HTTPS feed address (no keys or passwords in it), time zone, check interval and how long a reading may be quoted.
3. Give the JSON pointers for each value (for example `/game/home/score`), the status words (`LIVE = in_progress`, `true = open`, `false = down`), and the provider timestamp pointer and format. Map a provider timestamp whenever the feed has one.
4. The source is created **off**. Press **Test**. The worker fetches once and the result appears on the card (worked, or the failure category). A test never changes what guests see.
5. Press **Turn on**. The guide starts using it on the next scheduled poll. Watch the state badge: Fresh, Stale, Unavailable or No reading yet. Stale and unavailable sources are never quoted.
6. **Turn off** at any time; fetching and guest use stop immediately.

## Fixture-tested versus real provider

Everything is verified against fixtures only:

- sports fixtures: fresh score, stale provider timestamp with a fresh fetch, outage, zero score, missing value, null value, invalid types;
- ride fixtures: zero wait versus missing, open versus down, stale, conflicting status;
- hostile fixtures: invalid schema, oversized payload, non-JSON, private and metadata addresses, DNS rebinding (mixed answer), redirect to a private or non-allowlisted host, cross-tenant connector ID, "ignore previous instructions" text in provider fields;
- behaviour: no repeated provider calls for duplicate jobs or repeated guest reads, bounded retries, disable stops fetches.

Not exercised: any real partner endpoint, real DNS, real TLS, real rate limits or real payload shapes. The worker's default socket implementation (`defaultRequest` in `apps/workers/src/lib/live-data-fetch.ts`) is covered only through its injected seam; it has not been run against a live host. Treat the first real feed as a staged integration with stage evidence.

## Known gaps and follow-ups

- **No push mode.** A signed webhook (HMAC per connector secret, timestamp tolerance, replay protection) needs a new plain Next.js route handler, which `CLAUDE.md` says requires an explicit boundary review. No existing reviewed boundary fits, so pull only is implemented. Follow-up: a boundary review and a replay table.
- **No stored credentials.** Providers that require an API key cannot be configured yet. Follow-up: store the key in the existing encrypted integration credential store and have the worker attach it as a header; never the URL.
- **Answer attribution.** Live facts are in the model context but are not yet recorded as a new evidence source kind in guest answer attribution snapshots (that contract is pinned and needs its own change).
- **Operator visibility of retrieval relevance.** All active connectors for the venue are included each turn (capped at 20 and a short line each). Relevance filtering is not implemented.
- **Disposable-database tests.** The migration was validated for Prisma schema correctness, generation and the tenant registry; it was not applied to a disposable Postgres in this packet.
- **Open web.** Remains off. If a future approved use case wants a platform-admin-controlled browsing capability, it needs its own design (allowlist, accounting, attribution) and must not reuse the live-connector path.
