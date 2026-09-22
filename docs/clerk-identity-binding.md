# Production Clerk identity binding

Application `User.id` and `Tenant.id` remain stable. Deploy the verified server-only
`CLERK_IDENTITY_BINDING` JSON with the production Clerk keys. Production identity
operations refuse a missing map; unconfigured staging keeps its existing behavior.
No migration, rekey, email matching, invitation, or membership grant is performed
by the binding itself.

```json
{
  "version": 1,
  "issuer": "https://clerk.production.example",
  "instanceId": "ins_VERIFIEDPRODUCTIONINSTANCE",
  "webhookSecretSha256": "REPLACE_WITH_LOWERCASE_SHA256_OF_EXACT_WEBHOOK_SECRET",
  "users": [
    {
      "providerId": "user_VERIFIEDPRODUCTIONTOM",
      "applicationId": "user_VERIFIEDEXISTINGTOM"
    }
  ],
  "organizations": [
    {
      "providerId": "org_VERIFIEDPRODUCTIONMINIATURE",
      "applicationId": "org_3HN2BNDTxN9EU5HrfMOh9gWIxao"
    },
    {
      "providerId": "org_VERIFIEDPRODUCTIONSPACE",
      "applicationId": "org_3HV2vyn6xVr0wPRx2PAmC6AH7V2"
    }
  ]
}
```

These are placeholders, not actual production provider IDs. The example deliberately
fails validation until its fingerprint and verified IDs are supplied. Compute the
fingerprint locally from the exact UTF-8 `CLERK_WEBHOOK_SECRET`, with no newline;
do not log the secret. `issuer` is the exact signed session `iss` and the HTTPS
origin of the frontend API host decoded from the production publishable key.
It is not necessarily the dashboard host `app.torchiko.com`. Both
`CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, when set, must
decode to that host. At least one is required and keys must be `pk_live_*`;
the server key must be `sk_live_*`. The release owner must verify the secret key
and publishable key belong to the same instance. A key prefix alone cannot prove
the ownership of a backend key without provider access.

The map accepts at most 100 users and 100 organizations and 64 KiB of JSON.
IDs must have their appropriate `user_` or `org_` prefix. Duplicate sources or
targets, cross-kind pairs, chains, cycles, identity pairs, extra fields, malformed
configuration and mismatched public-key hosts fail closed. Incoming retired IDs
and outgoing mapped provider IDs are rejected, so identity fallback cannot bypass
the map. New IDs outside the map use the existing onboarding path; conflicting
existing email/slug constraints fail rather than linking accounts by email.

## Boundary contract

- Server pages and HTTP routes use `@pathfinder/auth/server` for `auth` and
  `currentUser`. The returned IDs are application IDs. `currentUser` returns an
  application DTO, not a mutable Clerk backend resource.
- `resolveSession` translates the verified session's user and active organization.
  Provider roles and trusted platform metadata remain the authorization source.
  Neither the map nor browser metadata grants platform administration or ownership.
- Admin impersonation cookies remain application tenant IDs, gated by existing
  platform authority. Actor IDs stay the authenticated application user ID.
- Browser organization selection, onboarding and Clerk components continue using
  provider IDs. Never send the map to the browser or accept canonical identity
  overrides from client input or metadata.
- Outbound helpers accept application IDs and translate to provider IDs for
  organization creation, owner validation and invitations. Owner validation still
  requires the exact provider user, matching email and an owner-equivalent provider
  membership; it never links by email alone.
- The webhook route verifies the original body with Svix, then checks the signed
  `instance_id` and signing-secret fingerprint. Only its persistence projection is
  translated. Receipt identity is the original Svix ID and raw-body SHA-256.
  Existing transactional replay, membership cursor, deletion and audit behavior
  is unchanged. Unsupported webhook event types retain existing no-op processing.

## Release-owner sequence

1. Verify the new production instance, Tom's user identity, the two organizations,
   Tom's actual memberships/roles, existing application IDs and membership cursor
   readiness using the release owner's authorized access. Do not invent Earl/Meg
   accounts, link by email, or create invitations as part of this migration.
2. Prepare the complete immutable map, exact issuer, signing-secret fingerprint and
   matching public/backend keys. Retain the previous configuration for rollback.
   Check hosted CI and client-bundle canary verification for the candidate.
3. Keep replacement-instance login and webhook ingress unavailable until code,
   map and keys are installed together on every relevant server. Disable the old
   instance's webhook delivery to this endpoint. Do not run mixed old/new identity
   configuration against the same application data.
4. Enable the production endpoint with the exact secret and then login. Confirm
   Tom can select each museum, existing venue/content IDs remain unchanged, roles
   are correct, and audit actors still use the original application user ID.
   Confirm non-admin overrides and foreign object access fail. Use release-owner
   checks; local fixtures are not a live-account acceptance test.
5. Keep the map stable for this migration. Do not change mappings after webhook
   receipts are recorded: replay receipts intentionally bind the original provider
   event and cannot authorize a remap. A signing-key rotation also requires an
   atomic fingerprint update. Invitations remain a separate explicit delivery step.

Rollback must restore a mutually consistent code, provider keys, endpoint secret
and map. Never remove the map while replacement production identities can log in
or deliver events. Existing business IDs have not been rewritten, so no database
reverse migration is needed.
