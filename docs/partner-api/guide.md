# Partner Read API v1 guide (draft skeleton)

Status: draft for a dark, server-to-server read API. The contract now declares eight GET routes,
but the HTTP transport, OpenAPI, and end-to-end walkthrough are not implemented or verified.
Existing `pf_read_` credential lifecycle and the generic admin credentials page are separate
groundwork; neither makes this HTTP API available. This guide does not enable access.

## What this API is for

When implemented, an authorized partner backend may read the client and venue data explicitly
allowed by a scoped credential. It is intended for server-to-server calls. It is read-only and
does not provide visitor chat, write operations, or a browser SDK.

## Availability and access

The partner API is currently unavailable by default. This draft does not provision a customer
credential. Existing disabled `pf_read_` credentials are not HTTP authority and must not be accepted
by a future route as an implicit fallback. Access, if later approved, will require the global
partner API gate and a server-managed credential with explicit client, venue, and capability scope.
A credential will not grant website or app distribution entitlement, enable a guide, or bypass any
guide runtime gate.

Do not put credentials in a browser, mobile app, query string, source repository, or client-visible
configuration. The eventual transport and credential instructions must be documented and reviewed
before this section can become operational guidance.

## Intended read surface

The contract's declarative route catalog maps one GET path to each operation. None of these paths
is served yet:

| Path                                             | Read                            | Required capability     |
| ------------------------------------------------ | ------------------------------- | ----------------------- |
| `/api/partner/v1/client`                         | Authorized client               | `clients:read`          |
| `/api/partner/v1/venues`                         | Scoped venue list               | `venues:read`           |
| `/api/partner/v1/venues/{venueId}`               | Scoped venue summary            | `venues:read`           |
| `/api/partner/v1/venues/{venueId}/content`       | Approved visitor-facing content | `approved-content:read` |
| `/api/partner/v1/venues/{venueId}/configuration` | Partner-safe configuration      | `configuration:read`    |
| `/api/partner/v1/venues/{venueId}/guide`         | App WebView URLs and host theme | `configuration:read`    |
| `/api/partner/v1/venues/{venueId}/readiness`     | Partner-safe readiness          | `readiness:read`        |
| `/api/partner/v1/venues/{venueId}/updates`       | Partner-visible updates         | `updates:read`          |

The guide operation is narrower than configuration. Its projected response contains only the
venue ID, canonical app and compact-app HTTPS URLs, and a nullable `appBackground` color. The eventual
domain action must read the exact credential-scoped venue, derive its slug and configured origin
from server state, and require `resolveVenueDistribution(...).app.effective` before returning this
projection. A credential alone cannot enable the app door. Pagination and public-visibility rules
still need a shared canonical read service, as described in
[READ-SERVICE-REFACTOR.md](READ-SERVICE-REFACTOR.md). No `curl` examples are given for unserved paths.

## Integration steps

1. **Not available yet.** Client onboarding, credential creation, scope selection, and rotation
   instructions require an implemented admin workflow and security review.
2. **Not available yet.** Base URL, authentication header, endpoint paths, errors, rate limits,
   caching, and pagination require a verified HTTP route and generated OpenAPI document.
3. **Not available yet.** Guide WebView behavior should follow the existing [app WebView host
   guide](../distribution/app-webview-host-guide.md) only after the guide URL and entitlement
   contract are resolved. That guide is descriptive and does not enable partner API access.
4. **Not available yet.** A redacted local request walkthrough must cover every implemented
   endpoint and demonstrate revoke behavior before this guide can be considered ready.

## Security and data handling

The eventual API should use bearer credentials only over TLS, return no cross-origin browser
access by default, apply narrow tenant/client/venue scope on every request, and avoid writing
response bodies or key material to audit logs. Partners should store any future credential in
server-side secret storage, restrict access to the service that needs it, and redact it from logs.
These are requirements for implementation and review, not claims that a running service currently
enforces them.

## Status checklist

- [x] Declarative route and operation catalog agree; HTTP binding remains open.
- [ ] Shared read services enforce scope and partner-specific visibility.
- [ ] Credential authentication, revocation, limits, and body-free audit are implemented.
- [ ] Guide URL availability and entitlement behavior are defined and tested.
- [ ] OpenAPI is generated from the implemented contract and validates.
- [ ] Every endpoint has a redacted local walkthrough.
- [ ] Default-off behavior and inaccessible admin UI are proven.
- [ ] Cold read of this guide completed after implementation.
