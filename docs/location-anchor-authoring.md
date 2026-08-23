# Location anchor authoring

Torchiko's platform-admin venue workspace can maintain floors, verified anchors, and reviewed connections. The bounded guest `location.resolve` capability resolves anchors, `location.catalog` lists reviewed public destinations, and `location.route` returns a deterministic reviewed path between two public anchors. Entitled public venue chats expose these reads through a compact mobile route planner. This remains bounded venue guidance rather than live turn-by-turn navigation.

## Review lifecycle

1. A platform administrator creates an exact-tenant, exact-venue floor, anchor, or connection draft. The operation UUID is also the durable row identity, so an exact retry converges without duplicating data.
2. New records are always inactive. New anchors are not available to guest lookup, and new connections cannot silently become routing evidence.
3. An inactive draft may be corrected only against its exact `updatedAt` revision. Every correction requires a human reason and writes a strict audit record.
4. Activation is a separate exact-revision transition with a human source/review reason. Deactivation uses the same guarded path.
5. Active content must be deactivated before it can be changed, preventing an operator from silently changing already-reviewed guest guidance.

An authorized operational agent may call `torchiko.locations.propose_draft` with one typed anchor and bounded evidence. That action creates a medium-risk approval request plus run/action/timeline/audit evidence and moves the run to `AWAITING_APPROVAL`; it does not change venue content. A human approval still executes nothing. The location workspace exposes a second, exact-decision application control that converts an approved payload into an inactive draft. Guest availability continues to require the existing separate activation review.

All reads and mutations acquire explicit tenant/venue scope. Mutations also use the venue-content lock so topology review cannot race another venue-content operation. Stable keys are unique within a venue. Floors and parent anchors must be active and belong to the same tenant and venue; self-parenting is rejected.

Connection endpoints must be distinct anchors from the same tenant and venue. A connection can activate only when both endpoints are active. An active floor cannot be deactivated while an active anchor uses it, and an active anchor cannot be deactivated while an active child or connection depends on it. Reviewed active records must be deactivated before their content can change.

External map references accept only public HTTPS URLs without embedded credentials or secret-like query/fragment keys. Coordinate pairs must be complete and range-valid. Accessibility metadata is bounded to scalar facts.

## Deliberate limits

- Route resolution uses unweighted shortest-path traversal over active reviewed connections. It
  does not use live position, distance, travel time, turn geometry, crowd conditions, or an
  external navigation provider.
- `accessibleOnly` excludes every connection not explicitly marked accessible. This is a strict
  filter, not a claim that a resulting route has received a formal accessibility certification.
- It does not expose a direct operational-agent mutation tool. The proposal tool is a bounded alternative for anchor draft creation only; floor/connection creation, all edits, activation/deactivation, and approved-proposal application remain administrator-only operations. The public catalog and route queries are also not currently bound to operational-agent tools.
- Production activation and real-venue content remain subject to the production and customer-data boundaries.

Focused regression coverage lives in `packages/db/src/helpers/location-draft-proposal-actions.test.ts`, `packages/api/src/mcp/composition.test.ts`, `packages/api/src/routers/admin/location-authoring.test.ts`, `apps/dashboard/components/admin/VenueLocationAuthoring.test.tsx`, and `apps/dashboard/components/admin/VenueLocationTopologyAuthoring.test.tsx`.
