# Universal content operator actions

PathFinder's generalized content authoring surface is an internal, platform-administrator-only
workspace for `SERVICE`, `POLICY`, `EVENT`, `OPERATIONAL_FACT`, and `RELATIONSHIP` modules. Existing
Place and Knowledge workflows remain compatibility systems; optional Place references are checked
against the exact tenant and venue but are never rewritten.

## Safety and lifecycle contract

- `GENERALIZED_CONTENT_CAPABILITIES_ENABLED` is server-owned and defaults to false. Read and preview
  remain available while disabled; every durable authoring mutation fails closed.
- Every action identifies a signed-in `HUMAN` platform administrator. The identity, revision,
  typed payload, evidence records, and strict audit record are written in one transaction.
- A module identity is stable. Content revisions and their typed payload/evidence rows are append-only.
  Editing appends `version + 1`; retirement appends another revision with an `effectiveUntil` boundary.
  No update or delete operation exists in this action layer.
- Revision and retirement actions require the latest displayed version. The unique
  `(module, tenant, venue, version)` constraint closes concurrent races; stale requests return a
  conflict and write nothing.
- Creation uses a client-generated UUID as both the durable module ID and request key. A retry after
  an ambiguous network result cannot create a second module: the primary-key conflict instructs the
  operator to refresh and inspect that exact request key.
- Relationship endpoints, and optional compatibility Place references, must resolve inside the exact
  requested tenant and venue. Cross-tenant or cross-venue references fail before a revision is written.
- Audience is recorded as revision metadata. This action layer has no guest/client publication path;
  previews always return `guestVisible: false`, `clientVisible: false`, and
  `requiresExplicitPublication: true`, including for a `PUBLIC` audience.

The Internal Workspace editor exposes validation/preview separately from mutation, makes the feature
flag state visible, supports evidence references and effective dates, and displays the creation request
key for recovery. No migration or live database operation is required for this layer.
