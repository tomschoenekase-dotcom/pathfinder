# Golden Venue acceptance runbook

Use only disposable local infrastructure or an explicitly authorized synthetic staging environment. The fixture identifiers and expected answers live in `scripts/golden-venue/fixture.json`. The existing guarded seed refuses any environment other than explicitly confirmed staging; do not weaken that guard.

## Setup and reset

1. Run `pnpm golden-venue:validate`.
2. Start disposable/local staging and run the disposable migration gate.
3. For an authorized synthetic staging seed, satisfy every host/database confirmation required by `assertStagingSeedTarget`, then run the fixture's `seedCommand`. This is an environment-changing action and is not authorized by this packet alone.
4. Reset by recreating the disposable database. Never broad-delete a shared staging or production database.

## Lifecycle evidence checklist

For each required phase, record timestamp, actor/surface, stable record ID, URL or artifact hash, expected result, observed result, and status. Cover client, venue, onboarding, upload/intake, review, content/package/evaluation, release, guest retrieval/chat, feedback, report, support, operational update, and export/offboarding.

Ask every expected fixture question. Record the assistant answer and source records. A text match alone is not grounding evidence.

## Failure injection

- Provider outage: disable provider access before dispatch; expect `PROVIDER_UNAVAILABLE` and no ambiguous retry.
- Rate limit: exhaust a disposable rate bucket; expect `RATE_LIMITED` and a bounded retry.
- Bad upload: submit a mismatched or scanner-rejected disposable object; it must remain quarantined/rejected.
- Duplicate request: replay the same operation ID and immutable input; expect one result/evidence chain.
- Failed worker: terminate a disposable worker after claim, then verify lease/retry/redrive behavior.
- Report failure: inject a deterministic provider failure and verify failed/stuck visibility.
- Ambiguous provider outcome: fail persistence after dispatch; expect history reconciliation and no automatic provider retry.

Provider-backed phases must be marked `UNVERIFIED_PROVIDER_DISABLED` unless a spend-bounded authorized provider smoke actually succeeds. Never fake success.
