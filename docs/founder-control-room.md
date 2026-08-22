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
`admin.attentionConsole`. The interface states that limitation rather than claiming exhaustive
company awareness.

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

## Mobile behavior

The primary briefing, decision controls, and queue shortcuts use touch-sized controls. Worker
state renders as cards on narrow screens and as a table at desktop widths. Multi-venue and
tenant context remains behind scoped evidence links rather than being flattened into ambiguous
global actions.

## Production chat incident reconciliation

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
- General-purpose application engineering remains a separate Codex workflow.
