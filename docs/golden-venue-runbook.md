# Golden Venue acceptance runbook

Use only disposable local infrastructure or an explicitly authorized synthetic staging environment. The fixture identifiers and expected answers live in `scripts/golden-venue/fixture.json`. The existing guarded seed refuses any environment other than explicitly confirmed staging; do not weaken that guard.

## Setup and reset

1. Run `pnpm golden-venue:validate`.
2. Run `pnpm golden-venue:disposable` for the provider-dark core lifecycle. The command creates fresh,
   digest-pinned PostgreSQL, Redis, MinIO, and ClamAV containers on exact loopback ports, applies the
   complete migration lineage, executes exactly one non-skipped integration, and removes every exact
   container even after failure. It refuses remote Docker endpoints and strips inherited credentials.
3. Treat its `proofScope` output as authoritative. It proves client/venue creation, remote intake,
   authoritative upload evidence, review, a support-question handoff, and a complete service-led
   support resolution with private operator context and immutable terminal AI-run lineage. It also
   proves immutable package/evaluation evidence, explicit release and exact rollback, grounded
   provider-dark public chat through the
   production gateway for every expected fixture question, visitor-owned feedback, tenant-published routine updates, admin-published
   and client-read reports, plus a human-reviewed non-deleting export matrix finalized into
   versioned disposable storage with exact replay recovery. The chat proof uses deterministic
   in-process OpenAI/Anthropic client seams with outbound credentials and provider workers disabled;
   it proves routing, retrieval, persistence, ownership, and analytics, **not** live-provider answer
   quality. The support proof performs no external send, package mutation, or approval creation;
   its AI lineage is evidence rather than execution authority. `EXPORT_READY` proves bounded
   artifact evidence only; it does not prove customer
   cancellation, revocation, deletion, delivery, or retention policy.
4. Treat its `failureScope` output as the retained seven-class matrix. It proves founder-governed
   provider exclusion before generation dispatch, a shared-Redis rate limit, infected upload
   rejection, exact duplicate replay, fenced expired-worker takeover, durable report-worker failure,
   and terminal ambiguity with no provider redispatch.
5. For an authorized synthetic staging seed, satisfy every host/database confirmation required by
   `assertStagingSeedTarget`, then run the fixture's `seedCommand`.
6. Reset shared staging only through an approved, recoverable data procedure. Never broad-delete a
   shared staging or production database.

## Hosted read-only and provider smoke

After an exact staging revision passes the hosted release profile, run the retained mobile browser
smoke against the policy-owned origin:

```text
pnpm golden-venue:hosted-smoke -- --revision <exact-40-character-staging-sha>
```

The command refuses caller-supplied origins, verifies exact deployment/resource health first, and
then checks the synthetic venue arrival-to-chat journey at 390 × 844. It performs no provider call
by default. Retain its revision-keyed JSON report from `artifacts/hosted-golden-venue/`.

One named checked-in corpus question may be sent only with the separate one-run opt-in:

```text
PATHFINDER_ALLOW_HOSTED_PROVIDER_SMOKE=1 pnpm golden-venue:hosted-smoke -- --revision <exact-sha> --question-key shark-feeding
```

The provider report retains only answer byte length, SHA-256, and per-fact matches. A safe guest
fallback or missing expected fact fails the command. Provider credentials, model routing, spend
authority, and any required human-admin configuration remain outside this command.

Before enabling the provider smoke, a human `PLATFORM_ADMIN` must verify that the synthetic venue's
effective model route is backed by a credential available in the exact staging web deployment. Use
the governed Admin OS override workflow when a route change is required; do not direct-write the
configuration tables or treat the smoke opt-in as authorization to change provider routing.

## Lifecycle evidence checklist

For each required phase, record timestamp, actor/surface, stable record ID, URL or artifact hash, expected result, observed result, and status. Cover client, venue, onboarding, upload/intake, review, content/package/evaluation, release, guest retrieval/chat, feedback, report, support, operational update, and export/offboarding.

Ask every expected fixture question. Record the assistant answer and source records. A text match alone is not grounding evidence.
The disposable runner enforces this contract against the exact checked-in fixture; `golden-venue:validate`
is also a static release gate so question/proof metadata cannot silently drift.

## Failure injection contract

- Provider outage: disable provider access before dispatch; expect `PROVIDER_UNAVAILABLE` and no ambiguous retry.
- Rate limit: exhaust a disposable rate bucket; expect `RATE_LIMITED` and a bounded retry.
- Bad upload: submit a mismatched or scanner-rejected disposable object; it must remain quarantined/rejected.
- Duplicate request: replay the same operation ID and immutable input; expect one result/evidence chain.
- Failed worker: terminate a disposable worker after claim, then verify lease/retry/redrive behavior.
- Report failure: inject a deterministic provider failure and verify failed/stuck visibility.
- Ambiguous provider outcome: fail persistence after dispatch; expect history reconciliation and no automatic provider retry.

These seven failure classes run provider-dark inside the retained disposable flow. Provider-backed
quality must still be marked `UNVERIFIED_PROVIDER_DISABLED` unless a spend-bounded authorized
provider smoke actually succeeds. Never fake success.
