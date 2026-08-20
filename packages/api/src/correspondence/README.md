# Correspondence provider boundary

This package is the provider-neutral domain boundary for prospect correspondence. Gmail is the only
live prospect-provider key represented by the adapter. The deterministic fake exists only for tests.
Resend is intentionally absent from this prospect-outreach boundary.

`createGmailCorrespondenceProvider` contains provider normalization, MIME construction, incremental
history/reconciliation semantics, mailbox watch operations, ambiguous-send lookup, health behavior,
and fail-closed credential references. It does **not** connect a real mailbox by itself.

Operator/runtime work still required before Gmail is live:

- implement the `GmailApiClient` transport with the official Gmail API/client library;
- implement `GmailCredentialLeaseProvider` using an encrypted OAuth credential store with offline
  refresh-token handling (the current `ExternalAccessCredential` is a one-way verifier and is not
  suitable for OAuth tokens);
- validate OAuth callback state and exact redirect URLs;
- persist mailbox/account, history cursor, watch expiration, and health in the CRM schema;
- authenticate Pub/Sub JWT signature, audience, expected service-account email, and
  `email_verified` before persisting a notification receipt;
- schedule daily watch renewal and reconciliation independent of push delivery;
- keep prospect delivery disabled until the packet's internal-email gate is explicitly approved.

All inbound body content is normalized as `UNTRUSTED_EXTERNAL_CONTENT`. HTML is retained only as
bounded data and must pass a reviewed sanitizer before rendering. External content is never agent
instructions or authorization. Attachment handling is metadata-only in this foundation.
