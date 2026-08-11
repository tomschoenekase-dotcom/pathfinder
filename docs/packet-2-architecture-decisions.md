# PathFinder Packet 2 architecture decisions

This log records major product/architecture choices made while implementing the authoritative Packet
2 capture. It does not replace the packet.

## ADR-001: Four deliberately different human surfaces

Status: accepted

PathFinder uses one coherent visual language across four products with different complexity and
authority: PathFinder OS, Internal Client Workspace, Ultra-Simple Client Portal, and Guest
PathFinder. Route-group or deployment boundaries are not security boundaries; server procedures and
tenant/role authorization remain authoritative.

## ADR-002: One-venue-first client experience

Status: accepted

The client portal does not display organization-versus-venue hierarchy or a venue selector when the
client has one venue. Multi-venue switching appears only when useful. Internal operators retain
explicit client and venue scope at all times.

## ADR-003: Independent configuration axes

Status: accepted

Venue archetype, preset, audience, capability, and release feature flags are separate concepts.
Presets select strong defaults; capabilities enable modules; audience constrains access; feature
flags control rollout. No client-name conditionals or vertically forked infrastructure are allowed.

## ADR-004: Effective configuration is provenance-aware

Status: accepted

The configuration hierarchy is platform, workload/capability, preset, client, venue, and optional
experience. Operator interfaces should show the effective value, source, override state, and reset
behavior without exposing all layers to ordinary clients.

## ADR-005: Agent-native means shared domain actions, not privileged bypasses

Status: accepted

UI, workers, API, MCP, and agents must converge on canonical domain operations. Agent access and
autonomy are independent. Agent-originated actions require identity, run/action context, tenant and
venue scope, status, model/cost evidence where relevant, and approvals. MCP and API adapters may not
bypass authorization or duplicate business rules.

## ADR-006: Risky external surfaces launch dark

Status: accepted

MCP writes, partner API, SDK, autonomous public changes, and generalized content capabilities use
default-off rollout controls appropriate to their risk. The partner API is read-only for this
packet. Public launch, pricing, and production activation remain owner decisions.

## ADR-007: Database incident stop remains binding

Status: accepted

Packet 2 authorizes substantial local architecture and forward-only migration design but does not
authorize external database activity. Live/staging claims must identify evidence and cannot be
inferred from local code.

## ADR-008: Universal content remains granular and typed

Status: accepted

Shared content is modeled as distinct modules for places, items, knowledge, services, policies,
events, operational facts, and relationships. The shared envelope supplies venue scope, version,
audience, and evidence, but module-specific fields remain explicit. This avoids both museum-only
assumptions and a lowest-common-denominator content blob.

## ADR-009: Support is a reviewed change workflow

Status: accepted

Support requests are not unstructured chat that silently mutates production. They progress through
missing-information collection, internal review, patch drafting, validation, evaluation where
appropriate, approval, apply, and completion. Client-visible communication is structurally
separate from internal notes, and package/action references make outcomes auditable.

## ADR-010: MCP v0 targets the 2026-07-28 protocol and least privilege

Status: accepted

MCP v0 follows the current official protocol revision at implementation time
(`https://modelcontextprotocol.io/specification/2026-07-28`). Resources and tools use explicit,
bounded schemas and structured results. Every adapter receives a prevalidated credential scope and
calls the same canonical domain actions as first-party surfaces. HTTP transport is not launchable
until protected-resource discovery, audience-bound OAuth tokens, scope challenges, rotation,
revocation, rate limiting, output sanitation, and audit requirements are implemented and verified.
Read and draft capabilities precede production writes; tool annotations are descriptive rather than
an authorization boundary.

## ADR-011: Evaluation content identity is a canonical effective snapshot

Status: accepted

Evaluation runs freeze a domain-separated hash of a versioned canonical manifest, not a mutable row
counter. The manifest includes only effective guest-facing venue, place, knowledge, operational,
prompt/config, and PUBLIC universal-content fields, with stable ordering and Unicode normalization.
It excludes internal audiences, embeddings, source metadata, mutable audit timestamps, and secrets.
Tenant and venue are part of the hashed domain. A content-version watermark is retained only as
diagnostic evidence, not as the identity itself.

## ADR-012: Offboarding planning and execution remain separate

Status: accepted

An operator may create a confirmed REQUESTED offboarding plan and inspect its targets/evidence, but
the planning API has no execute, revoke, complete, retention, or deletion operation. Future execution
must use canonical audited domain actions and be separately authorized. Retention/erasure behavior
cannot be inferred from account closure and remains owner/legal-policy gated.

## ADR-013: Client lifecycle is a derived read model

Status: accepted

The ten Packet 2 client lifecycle states are resolved from existing scoped venue, intake, package,
availability and offboarding evidence. They are not a new mutable status column and cannot be
advanced by a portal button. The client sees only required tasks and plain-language human milestones;
operators retain the underlying evidence in internal surfaces. When evidence is incomplete, the
resolver chooses the conservative state rather than inventing progress.

## ADR-014: Legacy client URLs fail closed into the simple portal

Status: accepted

Navigation removal is insufficient for the Ultra-Simple Client Portal boundary. Direct legacy URLs
for analytics, design tools, venue/content management and other internal functions redirect to the
nearest approved portal destination. Redirects preserve bookmarks and compatibility while ensuring
the old page cannot render client-visible internal tooling. Server authorization remains the final
security boundary.

## ADR-015: AI workload configuration is centralized, truthful and default-off

Status: accepted

Provider/model identities and workload policies resolve through platform, workload, client and venue
layers with explicit effective-source attribution, fallback, budget and cost bounds. Read surfaces
may expose only secret-free resolved configuration. A layer without durable persistence is labeled
unavailable, not synthesized. New or unsafe provider/model changes remain disabled until a reviewed
configuration and authorized execution path exist.

## ADR-016: Support lineage is not package execution

Status: accepted

A support request may be linked at an exact request version to an existing same-scope `DRAFT`
VenuePackage. The lineage record is append-only, HUMAN-operator attributed, CAS guarded and audited.
It may not create a package, alter package status, approve, apply, roll back or complete the support
request. Those lifecycle actions remain separately reviewed domain actions.
