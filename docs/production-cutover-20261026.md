# Overnight candidate release scope — October 25–26, 2026

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

## October 26 later owner direction: release-focused QA

After the comparison grader stopped, the owner said: "you can keep on using the
budget and stuff and doing the testing things", "just keep on working on that and
just do the work that you need to do", and "We're not necessarily trying to compare
all the old shit anymore."

This supersedes the comparative blind-P2 requirement below. The selected release
remains Sol + Fast with the reviewed application changes. Reuse the completed
candidate answers for record-based QA; spend further calls only on unresolved
questions, necessary verification and live QA. Incorrect safety, availability,
date, hours or price claims still require correction before release. An unfinished
comparison is not represented as a passed comparison.

The original $15 total cap remains: account for prior spend and unknown-call
reservations before any new paid run. Keep the stopped journal closed; a new run
must use a fresh journal bound to the remaining shared budget, the scoped launcher,
serial calls and first-error stopping. The owner authorizes this resumed testing.
Exact-head CI, migration preservation, fresh backups and restore rehearsals,
staging admission, the 22:00–06:00 Central window, dormant queues, unchanged worker
flags, default-off status features and post-release visitor QA remain required.

## October 26 evening owner update

The owner selected `machine/torchiko/20261026-orphan-shell-fix` at
`6ac2284bacfa9a78a87e332cb082870d0a7a4449`, including prompt v44, as the new starting
candidate. This supersedes the historical source and model selections below. The final
release SHA still requires exact-head checks, CI, new captures and formal blind P2.

- "yeah. i agree to switch to sol fast" authorizes
  `GUEST_CHAT_DEFAULT_MODEL_KEY=guest-chat-sol-fast` at release.
- "ill give 15 dollar budget" sets a hard $15 cap for formal P2, using a fresh ledger,
  serial requests through `scripts/with-torchiko-openai.mjs`, stopping on the first error.
- "if stuff needs to be done, get it done." authorizes the rehearsed read-only dormant
  queue invariant for this release only, replacing the historical all-zero requirement.

Use the separate `release269-queue-preservation.mjs` checker and its versioned proof.
The staging web predeploy configuration selects it explicitly with
`--preserve-dormant-queues`; the standalone CLI default
remains the all-zero check. Production's private adapter supplies the same versioned
proof from its pinned read-only connection. Never relabel an all-zero receipt.
The new proof requires two snapshots at least 30 seconds apart, identical counts,
job identities/states/attempts and canonical key contents, zero workers on every queue,
and only the reviewed waiting business jobs and delayed schedulers. Unknown pending
queues, active/prioritized/child-waiting jobs, attempted jobs, expiring keys, overflow,
missing reads or permission errors refuse release. `EVAL_RO` and `CLIENT LIST` are
mandatory. Canonical contents are compared instead of unstable raw Redis DUMP bytes.
Database-session, stopped-service, preservation and freshness checks still apply.
Never execute, delete, move or pause queued jobs or change worker flags.

The owner subsequently requested: "Review and rehearse a read-only exception for
that delayed staging evaluation job, then keep going if it passes. Don’t run or
change any queued jobs or worker flags. Same $15 cap and release window."
After the complete read-only inventory also identified the companion recovery
scheduler, the owner clarified: "Include both after rehearsal".

Version 2 of the preservation proof admits at most one dormant delayed scheduler
in each of the staging-only `evaluation-run` and
`guest-answer-attribution-evaluation` queues. Their exact job names must be
`evaluation-run-dispatch` and `guest-answer-attribution-evaluation-recovery`,
respectively, with `repeat:<job-name>:<numeric-time>` identities. All original
zero-attempt, never-processed, no-consumer, freshness, complete-inventory and
unchanged-content checks still apply. Ordinary evaluation jobs, waiting jobs,
duplicates and the same scheduler names in production remain refused. The new
schema version prevents an old proof from silently standing in for this review.

Deploy staging and production only between 22:00 and 06:00 America/Chicago, after all
gates pass. Keep `GUEST_CHAT_TODAY_STATUS` off. `GUEST_CHAT_STATED_DATES=luna` does
nothing with Sol. After release, watch for 15 minutes, including first-text p95 and
fallback rate, and run visitor QA. Schedule/status engine development follows release
behind its own default-off flag. No email is authorized.

## Historical scope before the evening update

## Owner scope and immutable source

Tom's October 25 instruction, recorded in the assigned overnight packet:

> im gonna have codex work all night on this stuff ... make codex work so that when i wake up tomorrow the new version will be live in prod if it works well(well as in, its better than what was there before)

He also requested `GUEST_CHAT_STATED_DATES=luna` with this release. His subsequent instruction
was to finish that packet using Astra and Sol subagents. This authorizes the conditional release,
not a waiver of any acceptance gate. The production incident remains ACTIVE by default.

The reviewed application source is `bebd9f1791f82120caa528cc5a12060a0f0bc8ea`, tree
`847dbbb5fd90ece11fe0ef27fdc44e4c7c0ba02b`, based on production
`a18fde4b947561b70c1909c5df134ae3b1fef4e4`. Permitted follow-up changes are narrowly scoped
release admission tooling, its tests and this scope documentation. Guest prompt rules and migration
SQL remain frozen. The final documentation-bearing SHA must pass all checks again; this record
cannot name its own commit and is not evidence of a successful release.

## Exact migration scope

The preservation receipt is version 2. Logical archive restoration can renumber
enum sort positions while preserving label order, and PostgreSQL can redistribute
an unbounded varchar-literal array's text cast onto its elements. Schema comparison
normalizes only those two representations. Every enum label and relative order,
literal, predicate, constraint, column, index, function, trigger, policy and view
remains covered. Unknown expression forms stay byte-sensitive. A separate raw
`physicalSchemaHash` retains the original catalog representation and must remain
identical across the two live pre-mutation reads. Version 1 receipts are rejected;
new source-bound backup and rehearsal receipts are required. No migration SQL,
original data, physical ledger, ownership/ACL, queue or freshness guard is removed.
The enum representation is documented in the PostgreSQL 17 `pg_enum` catalog;
the literal-array rewrite was reproduced by a native PostgreSQL 17 dump/restore.

Only the complete 267-to-269 transition is admitted, never a partial 268-row endpoint:

- `20261022001000_deterministic_event_search_projection`, checksum
  `2089bc647ea8982fbebd2d874c60aa3fa014050a3d5bbddd7147fd632e1f6cf4`.
- `20261023001000_add_fact_applicability`, checksum
  `ff62453a47c7d64e1c30706935755a8f27b0694517b3bde07627c2bbd5cba664`.

The frozen 267 prefix is `cbad930003f17d1953495a8d477a64b138b55db29022632aa20b93b2b8af2e00`.
The full 269 manifest is `f2c54b4fda515d68a9f8e45227aac3b26c0b978f5a5505827a71b853fefc67f1`.
Both endpoints have 297 public tables. Reconcile all physical ledger rows independently,
including historical rolled-back rows; never silently filter, repair or overwrite ledger history.

The first migration can rebuild outdated current PUBLIC EVENT projections, invalidate embeddings,
reset dispatches and append content history. This release's bounded adapter must prove zero affected
event-projection rows before admitting a hosted transition. A positive or unknown affected count
stops release; populated transformation support requires a separate reviewed implementation and
rehearsal. Preserve every original row and column, including content history and dispatches;
never exempt an entire table from preservation comparison. The second migration must retain old
facts as unknown with default-empty applicability arrays and the new constraint enforced.

Already-269 code-only startup requires the migration opt-in closed and a schema-proof reference
bound to that exact source SHA. A later code-only release must explicitly bind its new SHA to the
reviewed compatible schema evidence. This does not require a fresh migration or backup. Legitimate
new applicability values are permitted after migration; old-fact defaults are a transition check.

Staging predeploy reads all 28 canonical queues directly from the pinned staging Redis resource
using `EVAL_RO` and only `LLEN`/`ZCARD`. It reads again after the final database snapshot, so an
earlier image build cannot make queue evidence stale. Waiting includes paused jobs; waiting,
active, delayed, prioritized and waiting-children counts must each be zero. No queue, scheduler,
job or marker is created, repaired or removed. The image carries an isolated jobs dependency
closure for this reader; existing `REDIS_RESOURCE_ID` supplies the resource identity. Static staging
queue JSON is not admission evidence. Production's private queue receipt must still come from a
fresh complete-registry read within 60 seconds, including the final pre-mutation read.
The private production adapter may call exported `runRelease269` with the exact-service read-only
Redis collector as `readQueues`, preserving every source, target, backup and database guard. A static
file must not be reused after it expires; never refresh a timestamp without querying Redis again.

Writer drain means zero application, unclassified or active/transactional database clients.
Staging additionally requires zero other clients. Production retains the historical management
exception from the October 3 private `release-ops-lib.mjs`, narrowed to the role/application pairs
observed on October 26: `supabase_admin` with an empty application or `postgres_exporter`,
`authenticator` with `PostgREST`, `postgres` with `Supavisor`, and `pgbouncer` with the case-insensitive
`^supavisor([ /:_-]|$)` prefix. Every exception also requires state `idle` and no transaction.
A matching name under another role, an unknown client, missing metadata or any transaction blocks
release. Private session-classification receipts record these observations; they do not authorize
terminating provider sessions. Recheck the counts before and after preservation snapshots.
Each check clears only the current connection's statistics snapshot with `pg_stat_clear_snapshot()`
before reading activity, as required by [PostgreSQL's transaction statistics behavior](https://www.postgresql.org/docs/17/monitoring-stats.html#MONITORING-STATS-VIEWS).

## Required order and evidence

1. Complete clean candidate verification and the full API/script checks. Compare approximately
   80–100 development cases against the production source using identical saved data and verified
   production Sol settings. Grade blind against records. Candidate WRONG must not increase, passes
   must not decrease, pairwise wins must equal or exceed losses, and no candidate-only safety/time
   WRONG is allowed. Median latency and mean input tokens must remain within 1.3 times baseline.
   Keep one $10 ledger including live QA; stop all calls on any 429 or credit error.
2. Require exact-head CI and freeze the final source. Pause staging autodeploy without deploying;
   drain writers and external ingress. Treat staging as preserve-existing. Take a fresh post-drain,
   release-bound backup stored separately from the database, restore privately on local PostgreSQL 17,
   and rehearse the exact transition. Preserve ownership/ACL archive evidence and record local
   remapping; public-schema rehearsal does not prove full provider-platform restoration.
3. Require ledger, schema, indexes, constraints, original-data preservation and zero affected-event
   proof. Only then arm the staging web migration-only hold. Require verified-held
   exit 2, close both migration controls to 0, and release web, dashboard and dormant workers at the
   same SHA in that order. Require exact three-service staging admission before restoring autodeploy.
4. Independently repeat production drain, fresh backup, disposable restore/rehearsal and preservation
   proof against its actual current target. Use the reviewed release-specific admission adapter,
   with fresh same-invocation zero-writer/queue readback and source recheck immediately before execution.
   Staging receipts never substitute for production receipts.
5. Promote only from `codex/pathfinder-v2-staging` into `master` through the protected promotion gate,
   with current exact-SHA staging admission and all CI checks passed. Deployment is permitted only
   between 22:00 and 06:00 America/Chicago. The only production service-variable change admitted is
   `GUEST_CHAT_STATED_DATES=luna` on the two guest-serving services. An incompatible existing release
   override is a stop condition, not authority to change another variable.
6. Verify exact production SHA, watch health/errors for 15 minutes and ask 10 real visitor questions.
   Each answer must be correct against records. Record actual evidence, spend and every failed gate.

## Recovery and retained restrictions

Before promotion, verify recorded rollback deployment IDs and rehearse the prior application against
269 data. On a regression, use the documented deployment rollback, then a reviewed application revert
that retains the 269 schema and admission compatibility. Never remove migrated schema through a
whole-release revert or run a destructive down migration. Reverify health and source identity.

No seed, reset, restore over production or staging, manual data cleanup, worker flag flips,
Anthropic calls, email, new accounts, billing changes or secret disclosure is authorized. Gold and
holdout material remain excluded. Existing authenticated tools may consume credentials operationally;
never print or copy them. Stop for owner action if access, billing or dashboard intervention is needed.
Missing evidence is not a pass. A failed release gate leaves production unchanged.

Execution status when authored: local preparation only; CI, A/B, backup/rehearsal, staging admission,
production promotion and live acceptance are NOT PROVEN. Retain actual receipts outside this public
repository and record their identities in the release handoff after execution.
