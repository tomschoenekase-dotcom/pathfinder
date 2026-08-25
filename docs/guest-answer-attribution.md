# Guest answer attribution

Torchiko now preserves the exact evidence context needed to review factual claims in newly
generated public guest answers. This is an internal quality-evidence foundation. It does not
change the conservative citations shown to visitors, decide whether an answer is good enough, or
authorize a release.

## Evidence contract

Every newly finalized generated answer can retain `guest-answer-evidence-v1` inside the private
turn replay metadata. The bundle contains:

- the exact answer hash and prompt-contract version;
- hashes plus the exact static and dynamic system prompts used for that answer;
- the centrally resolved route-configuration version, when one exists;
- a deterministic, ordered snapshot of the venue profile and the bounded place, knowledge,
  operational-update, and published-content records supplied to generation; and
- an individual SHA-256 hash for every source snapshot plus one hash for the complete evidence set.

The contract admits at most 100 sources. Individual frozen source snapshots are bounded to 30,000
characters, the static prompt to 100,000 characters, and the dynamic prompt to 150,000 characters.
These are validation ceilings, not targets. The guest API response never includes this private
bundle; visitor-visible citations retain their existing safe retrieved-record projection.

SHA-256 verification proves that the reviewed answer, prompts, route version, source order, and
source contents are the same evidence that was frozen for the turn. It does not prove that an
evaluator's semantic judgment is correct.

## Claim review contract

`guest-answer-attribution-v1` records non-overlapping exact response spans as `SUPPORTED`,
`UNSUPPORTED`, `UNCERTAIN`, or `NON_FACTUAL`. A supported claim must cite at least one source from
the frozen evidence set; a non-factual span cannot cite a source. Every span must match the exact
answer text and every cited source identifier must exist in the bundle.

The resulting counts and support rate are recomputed from the annotations. They are descriptive
evidence only. The contract intentionally has no `passed` field, threshold, severity, release
decision, publishing action, content correction, route change, or permission change.

## Authority and persistence

The canonical recording action currently requires a human platform administrator, an exact
tenant/venue/completed-public-turn scope, and a UUID operation identity. It reloads the answer and
private evidence server-side, recomputes every hash, rejects legacy turns without frozen evidence,
and writes one append-only `GuestAnswerAttribution` plus strict audit evidence. Exact retries replay;
reusing an operation ID for different input fails closed.

An authorized venue-scoped worker with `conversations:review` may use
`torchiko.quality.list_answer_attributions` to read a bounded set of already-recorded reviews. That
tool cannot create or change an annotation. The broader human recording procedure remains
explicitly unbound from agent tooling.

The same capability may use `torchiko.quality.preview_answer_attribution_agreement` to compute a
bounded, deterministic calibration report from those immutable reviews. For each frozen
answer/evidence identity, only the newest review from each human actor participates. Independent
reviewer pairs are compared character by character, which makes coverage, support-label, and
supported-source agreement independent of how each reviewer segmented claims. Repeated reviews
from one actor, malformed snapshots, single-reviewer groups, truncated windows, and conflicting
answer identities are counted explicitly instead of being silently treated as agreement.

The report is content-addressed and exposes no reviewer identity, answer text, source text, visitor
identity, or location. Its rates are descriptive only: agreement does not prove that either reviewer
is correct. The report has no pass field, quality threshold, severity, release decision, content
mutation, or authority change.

The database enforces tenant, venue, session, and turn identity through composite foreign keys.
Database triggers and Prisma middleware reject updates and deletes, preserving historical reviews
even if later evaluators disagree.

## Verification

Focused contract, API, MCP, database-action, tenant-isolation, and migration tests cover:

- canonical source ordering and answer, prompt, source, and evidence-set tamper detection;
- exact response spans and source-reference validation;
- human-only recording, exact idempotent replay, conflicting-operation rejection, and strict audit;
- venue-scoped read capability and the absence of annotation/release authority;
- legacy-turn rejection and private evidence exclusion from the public response;
- append-only enforcement across the complete current migration lineage.
- deterministic segmentation-independent reviewer-agreement math, same-actor deduplication,
  malformed/identity-conflict exclusion, exact-venue API and MCP scope, and truthful mobile UI
  states.

The disposable shakedown applies the complete migration chain to a fresh loopback-only PostgreSQL
database with disposable Redis, MinIO, and ClamAV dependencies. It records and replays one exact
human-reviewed attribution, proves cross-scope rejection and append-only history, confirms that no
knowledge or operational state changed, and verifies complete cleanup. It performs no provider
call and therefore is not semantic-quality calibration.

## Remaining evidence and policy gates

Representative human-reviewed staging corpora still need to accumulate real agreement evidence,
claim-segmentation examples, and venue coverage before any threshold is recommended. Provider-backed
calibration is also outstanding. A threshold, automatic review policy, client-visible claim UI, or
autonomous evaluator write path is a separate product, cost, privacy, and authority decision.

No production deployment, provider enablement, customer contact, visitor-visible claim label,
pricing action, billing action, or release authorization is included in this implementation.

## Rollback

The migration is additive. Before activation, rollback is to keep the feature unused or revert the
candidate and its unapplied migration. After a migration has been applied, stop creating new
reviews and leave existing append-only evidence intact; do not down-migrate by deleting history.
Legacy turns and turns without `answerEvidence` continue to work normally and simply cannot enter
the exact attribution workflow.
