# Partner Read API v1 guide (draft skeleton)

Status: draft for a dark, server-to-server read API. The HTTP transport, OpenAPI, and end-to-end
walkthrough are not implemented or verified. Existing `pf_read_` credential lifecycle and the
generic admin credentials page are separate groundwork; neither makes this HTTP API available.
This guide does not enable access.

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

## Intended read surface (subject to contract alignment)

The current registry names client, venue-list, approved-content, configuration, readiness, and
updates reads. The packet also proposes venue detail and guide-link HTTP paths. Those lists do not
yet match. Endpoint names, response schemas, pagination, and guide entitlement behavior remain
unsettled; no route examples are provided until the contract and implementation agree.

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

- [ ] Route and operation catalog agree.
- [ ] Shared read services enforce scope and partner-specific visibility.
- [ ] Credential authentication, revocation, limits, and body-free audit are implemented.
- [ ] Guide URL availability and entitlement behavior are defined and tested.
- [ ] OpenAPI is generated from the implemented contract and validates.
- [ ] Every endpoint has a redacted local walkthrough.
- [ ] Default-off behavior and inaccessible admin UI are proven.
- [ ] Cold read of this guide completed after implementation.
