# Golden Venue acceptance runbook

Use only disposable local infrastructure or an explicitly authorized synthetic staging environment. The fixture identifiers and expected answers live in `scripts/golden-venue/fixture.json`. The existing guarded seed refuses any environment other than explicitly confirmed staging; do not weaken that guard.

## Setup and reset

1. Run `pnpm golden-venue:validate`.
2. Run `pnpm golden-venue:disposable` for the provider-dark core lifecycle. The command creates fresh,
   digest-pinned PostgreSQL, Redis, MinIO, and ClamAV containers on exact loopback ports, applies the
   complete migration lineage, executes exactly one non-skipped integration, and removes every exact
   container even after failure. It refuses remote Docker endpoints and strips inherited credentials.
3. Treat its `proofScope` output as authoritative. It proves client/venue creation, remote intake,
   authoritative upload evidence, review, a support-question handoff, immutable package/evaluation
   evidence, explicit release, and exact rollback. It does **not** prove provider-backed guest chat,
   visitor message feedback, report delivery, a routine operational update, or offboarding/export.
4. For an authorized synthetic staging seed, satisfy every host/database confirmation required by
   `assertStagingSeedTarget`, then run the fixture's `seedCommand`.
5. Reset shared staging only through an approved, recoverable data procedure. Never broad-delete a
   shared staging or production database.

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
