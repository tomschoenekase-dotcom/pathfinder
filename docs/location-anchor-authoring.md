# Location anchor authoring

Torchiko's platform-admin venue workspace can maintain the verified anchors used by the bounded guest `location.resolve` capability. This is an anchor lookup system, not turn-by-turn navigation.

## Review lifecycle

1. A platform administrator creates an exact-tenant, exact-venue draft. The operation UUID is also the durable row identity, so an exact retry converges without duplicating data.
2. New anchors are always inactive. They are not available to guest lookup.
3. An inactive draft may be corrected only against its exact `updatedAt` revision. Every correction requires a human reason and writes a strict audit record.
4. Activation is a separate exact-revision transition with a human source/review reason. Deactivation uses the same guarded path.
5. Active content must be deactivated before it can be changed, preventing an operator from silently changing already-reviewed guest guidance.

All reads and mutations acquire explicit tenant/venue scope. Mutations also use the venue-content lock so anchor review cannot race another venue-content operation. Stable keys are unique within a venue. Floors and parent anchors must be active and belong to the same tenant and venue; self-parenting is rejected.

External map references accept only public HTTPS URLs without embedded credentials or secret-like query/fragment keys. Coordinate pairs must be complete and range-valid. Accessibility metadata is bounded to scalar facts.

## Deliberate limits

- Floor and connection records are visible for context but cannot yet be authored here.
- This surface does not compute routes, walking instructions, or accessibility paths.
- It does not expose a direct operational-agent mutation tool. The four administrator operations remain explicitly unbound in the agent-operation inventory pending a reviewed proposal/approval contract.
- Production activation and real-venue content remain subject to the production and customer-data boundaries.

Focused regression coverage lives in `packages/api/src/routers/admin/location-authoring.test.ts` and `apps/dashboard/components/admin/VenueLocationAuthoring.test.tsx`.
