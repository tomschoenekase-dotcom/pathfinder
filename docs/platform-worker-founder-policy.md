# Platform worker founder-policy access

Torchiko exposes founder policy and a compact company operating view to future trusted internal
workers through separate read-only HTTP boundaries:

- `POST /api/platform-worker/founder-decisions` resolves exact current founder decisions.
- `POST /api/platform-worker/founder-operating-view` returns the bounded, versioned Founder
  Control Room projection, including descriptive autonomy evidence.

This is not customer MCP. Its credentials use a distinct `pf_platform_` token type and the closed
read-only capabilities `founder-decisions:read` and `founder-operating-view:read`. Credentials are
issued disabled, store only an Argon2id verifier, require explicit platform-admin activation,
support explicit revocation, and strictly audit every successful read. Tenant, client, and venue
identifiers are intentionally absent from the credential and request contracts. A tenant MCP token
is rejected before credential lookup.

The request contains one to fifty unique stable decision keys. Resolution is exact and current-only;
there is no fuzzy fallback. Missing keys remain explicit. Ambiguous current truth returns a
fail-closed reconciliation response rather than guessing.

Credential issuance returns plaintext once. Exact replay returns no plaintext. Activation and
revocation use optimistic timestamps and idempotent operation IDs. No credential is issued or
activated by migrations, fixtures, or startup. Connecting a worker and storing its one-time secret
remain explicit owner-controlled operations.

The operating view accepts only a bounded row limit. It reuses the same canonical attention,
briefing, run, action, approval-decision, and outcome evidence as the Founder Control Room. Its
autonomy-evidence schema v2 reports per-agent-identity execution outcomes, approval acceptance,
quality evaluations, and customer signals. It explicitly labels rollback rate, policy violations,
and confidence calibration unavailable until canonical evidence exists; it does not manufacture a
reliability score, claim exhaustive history, recommend approval reduction, or change permissions.

These endpoints cannot create questions, approve or acknowledge actions, change policy, contact
customers, deploy, or perform billing operations. No credential is activated automatically.
