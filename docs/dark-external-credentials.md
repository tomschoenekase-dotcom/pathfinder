# Dark external credential foundation

`ExternalAccessCredential` is shared metadata for future MCP and Partner Read API authentication.
Platform-admin issue, rotation, revocation, and one narrow agent-bridge activation path are wired;
no listener, secret verifier, request authentication, or last-used update is composed.

Credentials are bound to one tenant/client identity and optionally one venue. The current domain maps client identity to the tenant record and enforces `client_id = tenant_id`. A non-null `scope_key` makes client-wide and venue-specific composite foreign keys exact. Capability arrays are required and bounded. Every credential defaults to `enabled = false`; revoked credentials must remain disabled.

Only an Argon2id verifier and a short non-sensitive prefix may be persisted. Plaintext credentials must never enter the database, audit logs, APIs, or UI. The platform-admin API deliberately omits `secret_hash` and provides paginated metadata list and exact-scope detail reads only.

Rotation, revocation, and bridge-activation tables are append-only evidence linked through exact
tenant/client/scope composite foreign keys. Only a non-expired venue MCP credential containing
`agent-runs:execute` can be activated. Activation uses current-revision CAS, immutable operation
hash evidence, strict audit, and returns no plaintext. Rotation or revocation terminally disables an
active credential. No migration was applied by this implementation, and the presence of these
tables does not mean network authentication is operational.
