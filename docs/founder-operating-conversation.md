# Founder operating conversation

## Outcome

Torchiko's Founder Control Room now supports a phone-first operating conversation at
`/admin/operations`. It answers common operating questions from canonical Control Room state and
retains other founder direction as durable triage input. It is intentionally a trustworthy command
substrate, not a general-purpose coding interface or an unconstrained model chat.

## Deterministic read contract

The API classifies and answers these read intents without calling an AI provider:

- `TOP_PRIORITY`
- `DECISIONS`
- `INCIDENTS`
- `AGENT_ACTIVITY`
- `CUSTOMER_ISSUES`
- `CHANGES`
- `COSTS`

Each answer is derived from the exact `admin.attentionConsole` snapshot. Up to five evidence items
retain source scope, object type and ID, tenant/venue scope when applicable, and a review link. The
stored snapshot includes bounded counts, changes since the last founder review, known cost evidence,
coverage status, and the unresolved cost-anomaly threshold. This is bounded evidence rather than a
claim of exhaustive company awareness.

## Direction and authority boundary

Unmatched input is a `DIRECTIVE` with disposition `RECORDED_FOR_TRIAGE`. The response says exactly
what did not happen. Recording an exchange cannot:

- execute or enqueue work;
- answer a founder question or approve a proposal;
- contact a customer or prospect;
- change prices, billing, policy, or permissions;
- deploy software, spend money, or activate a provider.

Authorized platform workers receive recent conversation in the read-only founder operating view so
they can later triage direction under their existing credentials and policies. The conversation
itself grants no capability.

## Persistence and replay

`FounderOperatingExchange` is platform-scoped and append-only. The operation ID is globally unique,
and a canonical SHA-256 binds the operation, prompt, response, evidence, and snapshot. An unchanged
retry returns the retained exchange. Reusing the operation for different work fails closed. The
database rejects updates, deletes, and truncation. Strict audit evidence records intent,
disposition, hash, and the zero-authority boundary without copying prompt text.

## Verification

Focused API, database, dashboard, and accessibility tests cover classification, canonical answers,
evidence bounds, direction wording, replay, conflict handling, mobile touch targets, empty/history
states, and unknown-outcome retry. `pnpm test:founder-conversation:disposable` applies the fresh full
migration chain in isolated PostgreSQL and proves append-only update/delete/truncate rejection,
strict audit evidence, bounded history, and no tenant, venue, agent-run, approval, operational-event,
delivery, outreach, or billing effects. Disposable PostgreSQL, Redis, MinIO, and ClamAV resources are
verified absent after the run.

## Remaining boundary

This slice does not add open-ended natural-language reasoning, proactive notification, or
provider-backed synthesis. Retained directives can now enter the separately credentialed,
human-approved task handoff documented in [`founder-directive-task-handoff.md`](./founder-directive-task-handoff.md);
approval still performs no execution, and materialization only creates an exact queued agent run.
Hosted staging integration and any consequential production rollout remain separate gates.
