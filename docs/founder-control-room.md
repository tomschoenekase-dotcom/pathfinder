# Founder Control Room

## Purpose

`/admin/operations` is Torchiko's mobile-first founder operating surface. It turns bounded,
machine-readable operational queues into a short briefing, while preserving links to the exact
tenant, venue, agent run, approval request, support request, or operational event behind each
recommendation.

The page is intentionally decision-first rather than dashboard-first. Its first panel answers:

- what deserves founder attention now;
- which decisions are waiting;
- whether critical customer or platform risk is visible;
- what the AI workforce is doing;
- which customer items need review.

## Priority contract

The current deterministic priority order is:

1. action-required critical/error tenant operational events;
2. action-required critical/error platform operational events;
3. blocking agent questions;
4. unexpired approval requests;
5. blocked or failed agent runs;
6. customer support work;
7. a truthful clear-queue state.

This recommendation is derived only from the bounded queues returned by
`admin.attentionConsole`. The authenticated API returns a versioned `briefing` object containing
the selected priority, urgency, compact metrics, exact source scope/object identity, action target,
and whether any contributing queue has more rows. The dashboard renders that shared contract; it
does not maintain a separate browser-only priority algorithm. This gives authorized automation and
the founder interface the same machine-readable operating view while preserving the platform-admin
authorization boundary.

The interface states the bounded-snapshot limitation rather than claiming exhaustive company
awareness.

## Personal review checkpoints

The briefing includes an actor-scoped "since your last review" summary for critical risks,
decisions, completed agent runs, outcome signals, and customer support items visible in the bounded
snapshot. A first review treats the visible snapshot as new. Later reviews compare item activity
timestamps with the authenticated operator's last durable cursor.

The API also returns a priority-sorted change digest with exact source identity and evidence links.
Critical customer/platform risks and founder decisions precede customer items, outcome evidence,
and completed work even when routine activity is newer. The mobile interface shows at most five
items and explicitly reports when the digest or any contributing source queue may contain more.
This removes the need to scan every queue merely to identify the visible changes while retaining
the full queues below for context.

`admin.markFounderBriefingReviewed` appends a checkpoint bound to the exact server-generated
briefing timestamp, briefing schema version, authenticated operator, expected previous cursor, and
idempotency operation ID. Checkpoints advance monotonically and cannot branch from the same prior
cursor. The database rejects updates, deletes, and truncation of this evidence.

This is review evidence only. Recording it does not acknowledge or resolve an operational event,
answer a question, decide an approval, resume a worker, or execute a queue item. Concurrent or stale
submissions fail closed and require a refreshed briefing. Counts remain a bounded visible delta,
not a claim of exhaustive historical accounting.

## Decision and execution boundary

The Control Room lets the founder answer an agent question or record an approval decision in
place. Both paths preserve their existing safety contract:

- answering a question records durable evidence and may make a worker eligible to resume;
- recording an approval creates a terminal, auditable decision;
- neither form directly runs, applies, publishes, retries, or enqueues the proposed action;
- execution remains a separate policy-controlled worker action.

Optimistic concurrency for question answers uses the question's `updatedAt` value. Approval
forms retain their conflict/expiry checks and force a refresh when the outcome cannot be safely
confirmed.

## Agent trust evidence

The Control Room derives a versioned autonomy-evidence summary from bounded canonical
`AgentRun`, `AgentAction`, `ApprovalDecision`, and `AgentOutcomeObservation` records. Schema v2
reports run completion/failure, action success/failure/denial/cancellation, denominator-backed
approval acceptance, quality evaluations, customer signals, and a per-agent-identity breakdown.
Completion by itself is never treated as evidence of quality, and a denied action proves policy
enforcement rather than a policy violation.

The summary is deliberately descriptive rather than a reliability score. Negative evidence takes
precedence in the displayed state; mixed or inconclusive evidence remains unresolved; and even a
positive-only bounded sample does not prove reliability. The API therefore never recommends an
approval reduction from this projection. Any future permission change requires a separate,
explicit policy decision using task-specific evidence and must retain the existing capability /
policy boundary.

The evidence contract also names what it cannot yet measure honestly. Rollback rate is unavailable
until rollback records have a canonical link to the responsible run/action; policy-violation rate
is unavailable until there is an explicit canonical violation signal; and confidence calibration
is unavailable until stored predictions can be paired with outcomes. These unavailable states are
returned as machine-readable coverage labels rather than fabricated zeros.

## Machine-readable operating view

`admin.founderOperatingView` returns a compact, versioned projection of the same canonical
briefing, change digest, bounded metrics, and autonomy evidence used by the Control Room. The
platform-worker boundary exposes that projection at
`POST /api/platform-worker/founder-operating-view` behind a separately activated
`pf_platform_` credential with `founder-operating-view:read`. Both transports explicitly report
that they cannot execute, approve, acknowledge, or mutate policy.

The worker transport is deliberately separate from tenant/customer MCP and does not widen that
credential model into a generic cross-tenant customer tool. Every successful read is strictly
audited; the endpoint fails closed when authentication, snapshot construction, or audit persistence
is unavailable. Credential issuance and activation remain explicit platform-admin actions.

The same separately credentialed boundary exposes
`POST /api/platform-worker/operations-readiness` for a bounded platform-wide v2 readiness view.
It requires `operations-readiness:read`, accepts no selectors, observes every canonical BullMQ
queue, and makes incomplete or unavailable live observation degrade readiness. It does not expose
job identity, payload, failure detail, tenant/venue attribution, or queue-control authority.

## Reviewed agent improvement loop

Explicit outcome observations can now be assembled into an immutable, versioned improvement
proposal for one exact tenant, venue, target identity, and task class. The proposal freezes the
evidence membership, a descriptive baseline, hypothesis, proposed change, and validation plan.
It appears through the normal approval system and can be read or prepared through the bounded MCP
catalog by a specifically authorized quality worker.

After human approval, an authorized quality worker or platform admin may attach one immutable
implementation reference and a baseline/candidate evaluation comparison. The evaluation corpus and
evidence must match exactly; content, model, or configuration differences are comparable only when
declared. The stored comparison is append-only and records actor/run provenance.

This is intentionally not automatic self-modification. A proposal decision or validation record does
not edit prompts, change routing or models, enable tools, loosen permissions, execute production work,
or promote a worker. Implementation remains a separate Codex/admin step, and any eventual authority-
promotion policy remains founder-governed.

## Mobile behavior

The primary briefing, decision controls, and queue shortcuts use touch-sized controls. Worker
state renders as cards on narrow screens and as a table at desktop widths. Multi-venue and
tenant context remains behind scoped evidence links rather than being flattened into ambiguous
global actions.

## Production chat incident reconciliation

Grouped `guest-chat.route-degraded` alerts expose an on-demand, read-only evidence inspection for
the latest affected turn. It correlates the exact durable turn, provider-operation outcome, and
linked sanitized usage record without loading conversation text. Successful reads are strictly
audited. The control does not retry a turn, alter provider health, acknowledge the alert, or change
incident policy; those remain separate authority surfaces. Legacy venue-only alert pointers fail
explicitly because the system cannot prove an exact turn correlation for them.

The August 22 production chat repair established that durable guest messages require both
`venueId` and `sessionSequence`. The current branch already supersedes the minimal hotfix with
the stronger `reserveGuestChatTurnAction` / `finalizeGuestChatTurnAction` lifecycle, including
tenant/venue-scoped monotonic sequence allocation. Regression coverage now asserts that both
the visitor and assistant message retain tenant, venue, session, turn, session sequence, and
turn-message sequence identity during finalization.

The older minimal hotfix is therefore not cherry-picked: doing so would duplicate a weaker
implementation. Its incident invariant is retained as an explicit regression test instead.

## Known boundaries

- External urgent escalation channels are not established policy and are not invented here.
- The Control Room does not authorize production deployment, live billing, pricing changes, or
  customer commitments.
- A clear bounded snapshot is not proof that every external system is healthy.
- A review checkpoint proves only that one authenticated operator marked one generated briefing as
  reviewed; it is not approval or execution evidence.
- General-purpose application engineering remains a separate Codex workflow.
