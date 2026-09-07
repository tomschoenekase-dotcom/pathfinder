# Prospect reply stop before provider dispatch

Queued campaign messages check for a recorded inbound reply both when claiming the
outbox and immediately before provider dispatch. The lookup is restricted to the
prospect organization and matches the frozen recipient, non-null contact, or a
thread linked to the same campaign member. It uses ingestion time relative to the
frozen send item, so a newly synchronized reply with an older provider timestamp
still stops delivery. A member already marked REPLIED also stops delivery.

A first attempt becomes CANCELLED. A retry becomes AMBIGUOUS because an earlier
provider attempt might have succeeded; a reply does not prove that nothing was
sent. Batch status is reconciled to PARTIAL or ATTENTION_REQUIRED. Last-mile
terminal writes compare the exact claim owner and lease before changing the item.
A lease that expires during the reply lookup cannot authorize dispatch.

This is a last observed database check, not an atomic transaction spanning an
external provider call. A reply arriving after that check can still race with the
provider. Existing provider recovery and first-send approval requirements remain.

## Verification status — 2026-09-07

- 29 focused database unit tests pass, including lost-lease terminal writes,
  expiration during reply lookup, and first-attempt versus retry ambiguity.
- 10 related worker tests and 13 disposable-runner isolation/reporting tests pass.
- Database typecheck and scoped lint pass; SQL and bypass inventories are unchanged.
- The final extended fixture passed on a fresh, isolated native Windows
  PostgreSQL 16.15 / pgvector 0.8.6 database after all 223 migrations. Exactly one
  integration test passed, none failed or skipped. This includes synthetic retry
  ambiguity and batch terminal-state readback, with no provider dispatch.
  The server was stopped and its loopback port released; the database directory
  and logs were deliberately retained. See the [native proof record](evidence/prospect-native-postgres-2026-09-07.json).
- The same journey also passed with PostgreSQL explicitly configured to UTC,
  after discovering that the native cluster inherited the host timezone.
  That [separate UTC readback](evidence/prospect-native-postgres-utc-2026-09-07.json)
  retains 224 applied migrations and one passing test; it does not exercise the
  unrelated intake tables added by migration 224.
- Docker remains unavailable. The earlier Docker runner attempt's cleanup state
  is still unknown until that engine can be inspected; the separate native proof
  does not establish Docker resource removal.

When Docker is available, run `pnpm test:prospect-outreach:disposable` with
`PATHFINDER_ALLOW_DISPOSABLE_PROSPECT_OUTREACH=1`. The runner requires a fresh,
isolated database, applies the migration chain, keeps providers and workers dark,
and checks removal of its exact resources. Its synthetic retry states do not
represent real provider sends. No live outreach has been executed as proof.
