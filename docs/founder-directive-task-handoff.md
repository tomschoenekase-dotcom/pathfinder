# Founder directive task handoff

## Outcome

One retained `DIRECTIVE` from the Founder Control Room can now become a canonical agent task without
collapsing capability into policy. The lifecycle is deliberately three separate effects:

1. an explicitly activated platform worker proposes one exact tenant, venue, enabled agent
   identity, prompt, rationale, risk class, constraints, and optional prospect scope;
2. the founder records a terminal decision through the existing approval system;
3. a separately capability-gated platform worker materializes only the exact approved proposal into
   one canonical `QUEUED` `AgentRun`.

The Control Room shows the original founder direction, proposed task, rationale, and constraints in
the approval card. A broad or ambiguous directive must first be narrowed to an exact venue-owned
task. The worker cannot silently reinterpret a second proposal for the same retained directive.

## Capability separation

The platform credential capabilities are independent:

- `founder-directive-tasks:read` reads a bounded lifecycle projection;
- `founder-directive-tasks:propose` creates only an approval request;
- `founder-directive-tasks:materialize` requires the exact approved decision and creates only the
  canonical task/run lineage.

All three are disabled until a human platform administrator issues and activates a credential. A
customer MCP credential is never accepted. Credential activity is rechecked inside each database
mutation rather than trusted only at the HTTP boundary.

## Durable evidence and replay

`FounderDirectiveTaskRequest` binds the source exchange and snapshot hash to one exact scope,
identity, prompt, rationale, constraint set, approval request, worker, and credential. The database
rejects proposal-field rewrites, invalid lifecycle transitions, deletion, truncation, and a
materialized run whose tenant, venue, identity, prompt, or initial state differs.

Proposal and materialization operation IDs are independently replay-safe. Reusing an operation for
different work fails closed. A second proposal for the same founder exchange is accepted only as a
deduplicated exact replay. A materialized task can be redispatched only while its canonical run is
still `QUEUED`; replay cannot requeue a running or terminal task.

## Retained authority boundaries

Proposal is not approval. Approval is not execution. Materialization authorizes only creation of
the exact agent task. The run receives the target identity's current bounded capability snapshot;
all downstream tools and approval policies continue to enforce their own authority.

This handoff grants no customer/prospect contact, pricing, discount, billing, deployment, provider
spend, policy mutation, production change, or valuable-data destruction authority. A prospect scope
can be retained only for an identity that already has a prospect capability, and it does not grant
sending authority.

## Verification

- contract and HTTP boundary tests cover strict schemas, capability separation, customer-credential
  rejection, and dispatch behavior;
- database and UI tests cover approval-state mirroring, exact Control Room context, and explicit
  no-execution language;
- `pnpm test:founder-directive-task:disposable` applies the complete migration chain to fresh
  isolated PostgreSQL and proves proposal, decision, materialization, replay, drift refusal,
  mutation protection, audit lineage, and zero external authority;
- the public-surface, tenant-bypass, tenant-registry, current-truth, and release gates include the
  new boundary.

Hosted staging integration, real operating-worker triage quality, task execution quality, and every
production/provider/customer action remain separately unproven or gated.
