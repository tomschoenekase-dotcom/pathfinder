# Third-party website widget preview

PathFinder has a small, classic-script loader for evaluating an embedded venue guide on an authorized third-party website. This is a **default-off staging kernel**, not a production widget launch and not completion of packet gate M4.

## Admission contract

The runtime must identify itself as staging, and both server-owned controls are required:

```dotenv
RAILWAY_ENVIRONMENT=staging
EMBED_PREVIEW_ENABLED=true
WIDGET_PREVIEW_ORIGINS_JSON={"museum-slug":["https://www.museum.example"]}
```

`WIDGET_PREVIEW_ORIGINS_JSON` maps an exact lowercase venue slug to one or more exact HTTPS origins. It is server-only and non-secret. The parser rejects malformed JSON, unknown shapes, HTTP origins, credentials, paths, queries, fragments, wildcards, whitespace/control/non-ASCII input, noncanonical slugs, oversized policies, and oversized rendered CSP directives. One invalid entry fails the complete policy closed.

Outside the exact staging environment—or when either control is absent, disabled, invalid, empty, or unmatched—`/embed/<venueSlug>` retains `Content-Security-Policy: frame-ancestors 'self'`. An admitted venue receives `'self'` plus only its configured origins. The request's `Origin` and `Referer` headers never grant authority. Query parameters may select a documented presentation inside the page, but they never grant framing admission: every query-bearing embed URL, including the app web-view's `?chrome=hidden` presentation, remains self-frame-only.

The response is private and non-cacheable, denies indexing, suppresses referrer data, and does not add CORS. CSP `frame-ancestors` is the browser-enforced admission boundary; this slice does not claim support for legacy browsers that lack it.

## Staging installation

After an operator has configured one exact venue and staging host origin, the authorized host may add:

```html
<script
  src="https://<pathfinder-staging-origin>/widget.js"
  data-pathfinder-venue="museum-slug"
></script>
```

The loader derives the PathFinder origin from its own script URL and inserts one titled, lazy iframe immediately after the script. It accepts HTTPS delivery, plus explicit loopback HTTP for local development. It does not accept a target origin, credential, mode, audience, archetype, location, or other authority from markup or query parameters.

## Deliberate limits and ownership

- There is no publishable widget key, durable per-venue policy store, operator UI, native bridge, cross-window messaging, or location-permission protocol.
- Widget traffic currently uses the existing `guest-web` attribution. It is not trustworthy `guest-widget` attribution and must not be reported as such.
- The venue's normal public availability, guest-chat limits, tenant resolution, provider controls, and incident controls remain authoritative.
- Enabling the flag, selecting staging venues/origins, validating the host website, and any production rollout are operator-owned decisions outside this local slice.
- M4 remains unapproved until the packet's durable policy ownership, identity/attribution, operational proof, and production gates are resolved.

## Verification and rollback

Run the web tests, type check, lint, build, and client-bundle secret scan before an authorized staging canary. Verify an admitted exact host, a different host, an unlisted venue, malformed configuration, a query-bearing embed, and the disabled flag.

From a clean checkout containing the exact deployed revision, an authorized operator can admit the live HTTP prerequisites with:

```bash
pnpm verify:staging-widget -- \
  --url https://pathfinder-staging.example.com/api/health \
  --expected-revision "$RELEASE_SHA" \
  --confirm-environment staging \
  --confirm-host pathfinder-staging.example.com \
  --venue-slug museum-slug \
  --expected-frame-origins-json '["https://www.museum.example"]' \
  --unlisted-venue-slug widget-admission-unlisted
```

Replace every example with independently confirmed staging values. The command first admits the exact healthy deployment revision, compares `/widget.js` byte-for-byte with the reviewed Git blob at that revision, requires every embed probe to report that same revision, requires the exact expected framing-origin list and privacy headers, proves `?chrome=hidden` remains self-only, proves one explicitly confirmed unlisted venue returns a protected self-only 404, and then rechecks the health revision. Its JSON output contains no response bodies or configuration values beyond the explicitly supplied non-secret host, slugs, and origins.

This verifier does not replace third-party browser proof. A real authorized host page must still execute the loader and frame the venue, and a different real origin must be shown blocked by browser CSP. It also does not prove guest chat behavior, staging resource isolation, dashboard/worker revisions, durable widget identity/policy ownership, trusted `guest-widget` attribution, rollback, or M4 approval.

Rollback is immediate and data-free: set `EMBED_PREVIEW_ENABLED=false` to close the entire embed preview, or remove the venue entry from `WIDGET_PREVIEW_ORIGINS_JSON` to restore self-only framing for that venue. Reverting the widget milestone removes the loader and dynamic framing policy. No migration or persistent data rollback is involved.
