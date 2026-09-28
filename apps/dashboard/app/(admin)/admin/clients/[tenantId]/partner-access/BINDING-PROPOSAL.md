# Partner access page binding

## Current boundary

This page is intentionally a presentation shell. The existing `/admin/clients/[tenantId]/credentials`
page calls `ExternalAccessCredential` procedures; those records are not the v1
`PartnerApiCredential` records. No dashboard `admin.*` procedure currently exposes the v1
service, so this page must not call the external-credential endpoints or Prisma directly.

The platform-admin route is already enclosed by `apps/dashboard/app/(admin)/layout.tsx`, which
requires an authenticated `PLATFORM_ADMIN`. That route check is only the page boundary: all data
and mutations still need server-side `adminProcedure` authorization and exact tenant binding.
The page also calls `isFeatureEnabled('partnerReadApi')` and returns `notFound()` while the
existing `PARTNER_READ_API_ENABLED` flag is off. Preserve this second gate when procedures are
added; page visibility and API authorization are separate boundaries.

## Minimal server binding

Add four platform-admin procedures in the admin router, each using the existing
`createDatabasePartnerApiCredentialService` from `@pathfinder/db` rather than issuing Prisma
queries in the dashboard:

- `listPartnerApiCredentials({ tenantId })` calls `service.list(tenantId)` and returns metadata
  only. It must never select or serialize `secretHmac`.
- `createPartnerApiCredential({ tenantId, label, venueIds, capabilities, expiresAt })` validates
  the tenant/client relationship and venue ownership, obtains the actor ID from the trusted admin
  context, selects the server-configured `dev | test | live` environment, and calls `service.create`.
  Return the generated token once with safe metadata; do not log it, put it in a URL, or persist it.
- `rotatePartnerApiCredential({ tenantId, id, expiresAt })` obtains the trusted actor ID and calls
  `service.rotate`. That service creates a linked replacement and returns its token once. It leaves
  the old credential active, so the UI must say so and offer explicit revocation after the new key
  has been delivered and verified.
- `revokePartnerApiCredential({ tenantId, id, reason })` requires an operator reason and calls
  `service.revoke` with the exact tenant ID.

All four inputs need bounded schemas. The admin procedures must derive authorization from the
authenticated context, never accept an actor ID from the browser, and map configuration/input/not
found errors to safe client responses. The current service fails closed when its pepper or
environment is invalid; preserve that behavior. List output may include IDs, public IDs, label,
environment, scope, capability names, timestamps, revoked state, and rotation lineage only.

## UI activation gates

1. Bind and test the procedures above, including cross-tenant denial, server-derived actor identity,
   omission of hashes, one-time token handling, and required revocation reason.
2. Replace the “Not loaded” and disabled controls with a metadata list and a create form connected
   only to those procedures. Include visible confirmation and a one-time reveal/copy/dismiss flow
   for create and rotate responses.
3. Keep rotate/revoke actions disabled when the selected row is not active. Make clear that rotate
   does not revoke the prior key; require a separate, reasoned revoke.
4. Retain the default-off deployment configuration and existing route-level platform-admin gate.

Until those gates are complete, this page must continue to state that no inventory or operation is
connected. It should not imply that an empty view means the client has no keys.

The disabled form is only a layout preview: venue selection and capability selection are not
implemented. Add both inputs before enabling creation. The environment remains server-configured
and must not become a user-controlled radio selection.
