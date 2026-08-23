# Platform worker founder-policy access

Torchiko exposes exact current founder decisions to future trusted internal workers through a
separate read-only HTTP boundary at `POST /api/platform-worker/founder-decisions`.

This is not customer MCP. Its credentials use a distinct `pf_platform_` token type, have only the
closed `founder-decisions:read` capability, are issued disabled, store only an Argon2id verifier,
require an explicit platform-admin activation, support explicit revocation, and audit every
successful policy read. Tenant, client, and venue identifiers are intentionally absent from the
credential and request contracts. A tenant MCP token is rejected before credential lookup.

The request contains one to fifty unique stable decision keys. Resolution is exact and current-only;
there is no fuzzy fallback. Missing keys remain explicit. Ambiguous current truth returns a
fail-closed reconciliation response rather than guessing.

Credential issuance returns plaintext once. Exact replay returns no plaintext. Activation and
revocation use optimistic timestamps and idempotent operation IDs. No credential is issued or
activated by migrations, fixtures, or startup. Connecting a worker and storing its one-time secret
remain explicit owner-controlled operations.

This endpoint can read policy and provenance only. It cannot create questions, approve actions,
change policy, contact customers, deploy, or perform billing operations.
