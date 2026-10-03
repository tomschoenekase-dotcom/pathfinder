# Reusable venue source connections

Connect a public webpage or structured JSON feed once, approve its mapping and publication
policy, and let the existing background worker maintain the venue's knowledge. Visitor questions
read the validated, published cache. They do not fetch the source or start a refresh.

This is code capability, not a deployment receipt. Installing this branch does not prove that a
hosted worker is running, approve a production source, or enable a production schedule. Follow
the existing release and production approval gates before using it on a hosted environment.

## Set up a connection

1. Add the source's origin to the venue's approved website origins. Production also requires the
   host in the existing live-data host allowlist. A credential-bearing or internal URL is refused.
2. In the dashboard's AI controls, open **Source connections**. Choose a webpage or structured
   JSON feed, enter its exact URL, timezone, refresh interval and freshness limit.
3. Map the records and their fields. For a webpage, use the supported simple tag, class or ID
   selectors and explicit text/attribute fields. For a feed, use JSON pointers. Configure a
   page-level date when the individual show or closure entries share the page's dated heading.
   A source can have several mappings for different record kinds without fetching it repeatedly.
4. Explicitly list permitted redirect targets and linked resources. Approval of an origin does
   not permit crawling every path on it. Links outside the connection's URL list are refused.
5. Set the validation bounds and publication policy. `auto_verified` allows subsequent valid
   updates within the approved mapping and policy. `review_required` keeps changes for review.
6. Save a draft, request a preview and inspect the extracted records, dates, links and warnings.
   Approve the exact preview and policy only when they represent the source correctly.
7. Inspect the connection's last success, error, published snapshot and usage. Pause to change
   its mapping or policy, then preview and approve the new version. Manual refresh uses the
   same worker, concurrency controls and request budget as scheduled refresh.

Routine refreshes use deterministic extraction and zero LLM tokens. This version supports
static HTML and configured JSON feeds. It does not execute page JavaScript, crawl arbitrary
links, infer a new mapping, or silently switch to an LLM when a page changes. Unsupported pages
and structural changes require a mapping repair and fresh approval. Prefer a structured feed
when the venue provides one that fits the supported adapter.

## Dates, freshness and precedence

- A successful HTTP check and a fact's effective date are separate. HTTP 304 can confirm that
  a page is unchanged; it cannot move yesterday's shows to today or extend a closure's dates.
- Daily operations use stricter freshness bounds than evergreen descriptions. Dated facts need
  explicit dates and venue timezone. Seasonal closures need an explicitly approved end date.
- Future events retain their dates. Cross-midnight intervals carry explicit start/end instants.
  Ambiguous or nonexistent local times are held instead of silently choosing a DST interpretation.
- Expired, malformed, out-of-policy and unavailable facts are withheld. The guest receives an
  uncertainty instruction and the approved source link. A disappearing closure never means open.
- Manual publications take precedence. A changed publication head stops an automatic source
  update from overwriting that content. That item stays human-owned: this version has no action
  that hands it back to the source. A source item that leaves the page and later returns is
  republished only while the connector still owns its latest revision and publication.

## Architecture and security

Versioned configuration and approval live in the existing venue-scoped `LiveDataConnector`,
with provider `source_connection_v1`. The existing polling queue owns refresh work;
`LiveDataObservation` holds the validated snapshot. Publication uses the existing typed content
modules, revisions, evidence, publication heads and knowledge projections. Source provenance and
earlier evidence remain available for diagnosis. No new migration or parallel knowledge database
is required.

Every operation carries tenant and venue scope. Guest retrieval rechecks source approval,
freshness, effective dates and the current publication head. General knowledge search cannot
bypass those checks by returning an old source embedding. Website text remains untrusted data
in both the extraction pipeline and the model context.

The fetch adapter admits exact HTTPS URLs on every redirect, validates every resolved address,
pins the connection to the admitted public IP, and bounds DNS, requests, redirects, retries and
response bytes. There are no cookies, source credentials, arbitrary scripts or model instructions
in the mapping. Request and byte counters expose maintenance usage; deterministic refreshes use
zero LLM tokens. Network-provider pricing is not assumed to be zero.

## MCP

Use `venues.list_source_connections`, `venues.get_source_connection` and
`venues.propose_source_connection`. The proposal action is one of `create`, `update`, `preview`,
`approve`, `pause`, `resume` or `refresh`. Reads never fetch. Each proposal uses the existing
grant, human approval and operation-receipt flow, then calls the same lifecycle services as the
dashboard. See [the operator manual](manual.md) for exact version and preview receipt handling.

## Local verification

Use synthetic HTML/JSON fixtures for extraction and transport tests, and a disposable database
for the lifecycle from configuration through publication and guest answers. Never use a live
venue page as a test dependency. The task handoff records the exact tested Git SHA, local proof
commands, browser viewports, pass/fail counts and any checks that remain unrun.
