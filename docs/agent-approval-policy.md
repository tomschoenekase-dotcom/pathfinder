# Progressive agent approval policy

Torchiko separates an agent's capability from the operating policy that determines whether one
use needs a fresh human approval. The first executable policy-backed action class is intentionally
narrow: `pathfinder.create_update_draft` with `updates:draft` authority.

A platform administrator can enable this policy from the venue Agent workspace for one exact
tenant, venue, agent identity, action, and capability. Issuance requires a stable policy key, an
idempotent operation ID, a human reason, explicit title/body bounds, and optional use and expiry
bounds. Every successful exercise creates an append-only `ApprovalGrantConsumption` with run,
worker, credential, parameter hash, and result lineage. Issuance and revocation are strictly
audited.

The registered evaluator accepts only a schema-valid informational `GENERAL_NOTICE` draft with
`INFO` severity and `NORMAL` priority inside the reviewed content bounds. It verifies the exact
tenant and venue and requires expiry after start. Unknown constraint versions, action classes, or
capabilities fail closed. A rejected attempt does not increment use count.

This policy does not authorize publication, scheduling, customer contact, billing, access changes,
or any action outside the venue. The existing one-shot exact-parameter approval path remains
available. No policy is created by a migration, fixture, startup routine, or agent; a human platform
administrator must enable it explicitly and can revoke it from the same mobile-responsive surface.

Disposable proof is available through:

```text
pnpm test:agent-approval-policy:disposable
```

The shakedown uses random disposable infrastructure, verifies one-shot compatibility, policy
issuance replay, bounded policy consumption, fail-closed parameter rejection, durable evidence,
and cleanup. It performs no provider call, publication, customer contact, or real billing action.
