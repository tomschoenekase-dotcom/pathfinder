# Embedding freshness audit and canary

This operator tool measures place and venue-knowledge embedding drift without calling Redis or an AI provider. The default mode is read-only and requires an explicit tenant. It scans active places and enabled knowledge in stable, tenant-bound pages inside one repeatable-read snapshot, reports grouped reasons, and never prints canonical content.

## Read-only audit

```bash
pnpm embedding:freshness --tenant-id <tenant-id> [--venue-id <venue-id>]
```

Use `--scan-cap <1..10000>` to lower the hard scan bound. A response with `truncated: true` is incomplete and must not be used for a canary decision. Reasons prefixed with `dispatch-` mean durable work already exists and will not be reset. `complete-claim-missing-vector-invariant-breach` requires separate claim repair; dispatching it would not restore the vector because the exact completed claim intentionally skips provider work.

`current-complete-revision-drift` is report-only. It normally means metadata outside the canonical embedding text advanced `updated_at`; matching source hash, provider profile, and a present vector remain fresh and must not trigger paid work.

## Staging-only canary

Canary mode inserts at most ten missing `EmbeddingDispatch` rows. It does not enqueue Redis work or call the provider. Existing due, backoff, or leased rows win with `ON CONFLICT DO NOTHING` and are never reset.

Before running it, independently verify that the database is staging, set `RAILWAY_ENVIRONMENT=staging`, and set `EMBEDDING_DISPATCH_ENABLED=false` on the operator process and worker. Then provide one exact venue, entity type, actionable reason, and a hard limit:

```bash
pnpm embedding:freshness \
  --tenant-id <tenant-id> \
  --venue-id <venue-id> \
  --entity-type PLACE \
  --canary-reason missing-vector-no-claim \
  --canary-limit 5 \
  --confirm-canary-entities 5 \
  --confirm-dispatcher-disabled true
```

The entity confirmation must exactly equal the canary limit. The dispatcher confirmation is an operator assertion: this database-only tool cannot verify a deployed worker's environment. The output reports selected IDs, inserted/skipped dispatches, the configured six attempts per BullMQ job, and an estimate for the one-job-per-entity case. That estimate is explicitly **not a hard provider-attempt bound** because an already-published or enqueue-before-ack duplicate BullMQ job is not visible from PostgreSQL. It does not estimate dollars without token counts.

Enabling `EMBEDDING_DISPATCH_ENABLED=true` afterward is a separate explicit staging action. Inspect the inserted dispatch count first, enable the dispatcher, observe `JobRecord` and structured worker logs, then disable again before expanding the canary. Production execution or an unbounded historical sweep requires separate authorization and evidence.

## Exact invariant repair

`complete-claim-missing-vector-invariant-breach` is excluded from the generic canary because a dispatch alone would be skipped by the exact completed claim. Use the separate one-entity command only in staging, with dispatchers independently disabled:

```text
pnpm embedding:claim-repair --repair-reason complete-claim-missing-vector-invariant-breach --tenant-id <tenant> --venue-id <venue> --entity-type PLACE --entity-id <id> --confirm-entity-id <id> --confirm-dispatcher-disabled true --actor-id <operator>
```

The command revalidates the exact complete claim, current canonical source/profile, active entity, absent vector, and dispatch state in one transaction. It preserves completion identity, changes the claim to `SUPERSEDED`, establishes current durable dispatch, and writes an audit record atomically. It refuses leased or stale dispatches. The mutating database helper independently rechecks the local staging and dispatcher-disabled environment. Deployed dispatcher disablement and the supplied actor ID remain operator assertions rather than independently verified identity.
