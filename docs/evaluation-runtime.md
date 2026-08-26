# Evaluation runtime (default-off)

PathFinder has a local implementation of the bounded evaluation runtime. It is not live-readiness evidence and it is not enabled by this repository change.

## Admission and execution gates

All three gates must be explicitly true before the API creates a run identity:

1. The workers process must start with server-only `EVALUATION_RUNNER_ENABLED=true`. The default is `false` in production, staging, preview, development, and tests. When false, the evaluation BullMQ consumer is not constructed.
2. `PlatformConfig[evaluation-runner-v1-global]` must contain the exact JSON `{ "version": 1, "enabled": true }`. This is the durable, cross-service rollout intent shared by the API and worker. Missing, malformed, or unreadable state is disabled.
3. The exact tenant must have the `evaluation-runner-v1` `TenantFeatureFlag` enabled. The admin request checks it before enqueueing, and the worker rechecks it before each case and immediately before provider dispatch.

When `EVALUATION_RUNNER_ENABLED=true` and `OUTBOUND_PROVIDER_WORKERS_ENABLED=false`, the worker
bootstrap selects the isolated `evaluation-only` runtime. That runtime requires Redis, both database
URLs, and the two registered evaluation-provider credentials, but constructs only the evaluation-run
and guest-answer-attribution queues and consumers. It rejects combination with the CRM-only or
intake-verification-only modes. This keeps a bounded evaluation window from waking embedding,
generation, media, email, reporting, billing, or other outbound-provider queues.

Disabling the process gate stops new consumer registration. Disabling either durable scope gate while a run is active causes remaining cases to receive `CANCELLED` operational evidence. Neither condition changes content or publishes a package. A process-env mismatch cannot be proven away by application code: the durable global record is the operator's cross-service coordination source, while every process-local gate still fails closed. A worker deployed with its local gate false consumes nothing even if another service is misconfigured true.

New identities begin `STAGED`, and the API never publishes execution work directly. A default-off worker scheduler scans a bounded batch after rechecking the durable global and tenant gates. It CASes the exact identity to `QUEUED` before deterministic BullMQ publication. Every scan also republishes `QUEUED` identities idempotently, repairing a crash between the database transition and queue add. The execution consumer refuses `STAGED`, so it never treats an early or malformed publication as complete or calls a provider. Pre-migration rows become `LEGACY`, never `QUEUED`; no historical completion state is inferred without an authorized database assessment.

## Frozen identities

An admin request persists one immutable `EvalRun` identity containing:

- ordered case IDs, revisions, and hashes;
- the production prompt contract version and hash;
- a canonical guest-facing content manifest plus its content version and hash;
- the registered model/provider specification plus its hash;
- the exact declared budget ceiling.

Package review uses two distinct snapshot kinds. `APPROVED_VENUE_PACKAGE_V1` preserves legacy approved-client-preview compatibility. `REVIEWABLE_VENUE_PACKAGE_V1` truthfully freezes the effective content of an exact error-free `DRAFT` or `APPROVED` package, including its package status, payload hash, base digest, and deterministic preview evidence. The worker re-parses and re-hashes that exact snapshot before provider admission. A reviewable snapshot never represents approval and cannot itself mutate package, support, publication, or customer state.

The queue payload contains only tenant, venue, run ID, and run identity hash. Before any provider dispatch, the worker verifies the stored run identity, content scope/hash, current prompt identity, model snapshot, each case snapshot/hash, and the configured prompt byte ceiling. It refuses to substitute a newer content snapshot or a changed model.

## Sanitized conversation-derived cases

The platform-admin evaluation console can prepare an immutable regression case from an unresolved public guest-conversation insight. This is a governed evidence-preparation action, not automated training or evaluation execution:

- the server revalidates the exact tenant, venue, public session, guest turn, reviewable insight category, and—when applicable—the currently active negative visitor rating;
- the operator must write a sanitized question, choose known-answer versus honest-unknown behavior, provide the lexical truth markers, and explicitly attest that personal and customer-identifying data was removed;
- the failed assistant answer is shown as source evidence but is never copied into the evaluation snapshot;
- each case retains exact insight and guest-turn provenance, uses append-only revisions, and replays only an identical hash and source identity;
- preparing the case acknowledges an unreviewed insight and writes a strict audit record without publishing content or changing current venue truth.

This workflow deliberately does not call an AI provider, spend an evaluation budget, define aggregate pass thresholds, or approve a release. Human-defined phrases are per-case truth assertions; release calibration remains a separate founder/product-quality decision.

## Regression alert policy

Automatic same-corpus regression alerts are capability-gated separately from evaluation execution.
The worker reads `PlatformConfig[evaluation-regression-alert-policy-v1]` and publishes no automatic
quality alert when that record is absent, disabled, malformed, or unavailable. An enabled version 1
record must explicitly provide both `minimumPassRateDrop` and `errorPassRateDrop`; the error drop
must be at least the minimum alert drop. The evaluation console reports whether this durable policy
is configured and, when it is, displays the exact thresholds.

Torchiko does not supply fallback percentages or infer a severity boundary. Stored runs remain
available for explicit human comparison when automatic alerts are dark. This preserves the
regression-detection capability without turning an unresolved product-quality judgment into policy.

## Provider-dark current-source coverage

Before requesting a current-live-content run, a platform administrator can inspect deterministic
lexical source coverage for the selected cases. The server verifies each immutable case, freezes
the exact current public venue-content snapshot, and checks whether each human-authored required
phrase or acceptable fact marker appears in a snapshot value. The response contains the snapshot
hash/version, marker IDs, counts, and the matched human-authored phrase; it returns no source text.

Coverage is evidence, not a quality gate. Missing lexical markers can mean missing content,
different wording, or a stale case. The preflight does not judge semantic equivalence, hallucination,
case acceptance, or release readiness, and it neither calls a provider nor starts a run. Approved/reviewable
package and native-release snapshots remain separately frozen execution targets; this initial
preflight is explicitly limited to current live content so it cannot imply it inspected a different
target.

## Provider-dark human-review calibration

The venue evaluation workspace and an exact-venue `conversations:review` MCP tool can compute a
read-only agreement report from append-only human guest-answer claim reviews. The report compares
independent reviewers of the same answer and frozen evidence identity at character granularity, so
different claim boundaries do not manufacture disagreement. It separately reports annotated-span
overlap, support-label agreement, and source-set agreement for spans both reviewers marked
supported.

Only the newest review per human actor and frozen identity participates. Malformed records,
single-reviewer groups, conflicting answer identities, repeated actor reviews, and bounded-window
truncation remain visible. The output is content-addressed and returns no answer/source text or
reviewer identity. It makes no correctness, pass/fail, severity, threshold, release, publication, or
permission decision and performs no provider call.

A separate provider-backed evaluator core can now produce the same exact-span attribution contract
from one frozen answer/evidence identity. It is centrally routed, admission- and budget-gated,
content-hash verified before dispatch, and strict about spans and source IDs. It is not connected to
the evaluation queue, admin API, persistence action, scheduler, release policy, or visitor UI, so no
automatic review occurs merely because the code exists.

## Lifecycle and failure semantics

Every queue attempt writes/upserts a `JobRecord`. The durable `EvalRun` state advances through compare-and-set transitions:

`STAGED -> QUEUED -> RUNNING -> COMPLETED | FAILED | CANCELLED`

The admin request may select only the registered `guest-chat` baseline or the registered
`guest-chat-openai` provider-diversity candidate. The API freezes the selected registry
specification into the run identity; the worker re-hashes it, resolves it back to that allow-listed
key, prices the prompt with that exact specification, and dispatches that exact key. Arbitrary
provider or model names are never accepted, and a changed registry entry fails closed instead of
silently evaluating a different model.

Retryable failure leaves worker ownership as `RETRY_SCHEDULED`; the next exact BullMQ attempt may claim `RETRY_SCHEDULED -> RUNNING`. Already-terminal cases are loaded and identity-checked, skipped on retry, and their exact stored cost is carried into the remaining frozen budget, preventing double dispatch and double spend.

Attempt number and maximum attempts are fixed and monotonic. A provider/operational error is retryable until BullMQ's third and final attempt. Only an exhausted attempt marks the run `FAILED`; a final attempt that successfully persists per-case operational failure evidence marks the execution `COMPLETED`, because execution finished even though quality was not scored. `EvalResult.outcome` keeps `SCORED` quality evidence separate from `OPERATIONAL_FAILURE`, `BUDGET_BLOCKED`, and `CANCELLED` evidence.

The run budget is durably enforced before provider I/O. For each exact tenant/venue/run/case/revision, the worker atomically increments `EvalRun.budgetAccountedE8Usd` by the registered maximum request cost and creates one unique `EvalRunCostReservation` tied to the claiming attempt. The increment cannot exceed the frozen declared ceiling and is never released, so concurrency and retries cannot reopen capacity. Provider success is settled with the exact observed cost in the same database transaction that creates immutable `EvalResult` evidence.

If a process disappears after reservation but before atomic result settlement, the retained `RESERVED` row is treated conservatively as an ambiguous provider outcome. A retry writes bounded `PROVIDER_OUTCOME_AMBIGUOUS` terminal evidence and transitions it to `AMBIGUOUS`; it never dispatches that case again. Provider exceptions are handled the same way because delivery/charging may be uncertain. This can intentionally consume more capacity than the ultimately observed charge, but it cannot exceed the declared run ceiling or double-charge through redispatch. Once capacity is unavailable, remaining cases become `BUDGET_BLOCKED` without provider I/O. Global AI incident controls and the separate venue AI cost gate remain in force.

`RUNNING` ownership is a durable 15-minute fenced lease. The worker renews the exact token before each case and again in the final provider admission guard. The dispatcher also scans expired `RUNNING` leases and publishes a deterministic recovery job. A redelivery may take over only the exact expired token; every reservation, finish, and failure CAS requires the replacement token. If the crashed owner had already reserved a case, recovery materializes ambiguous terminal evidence and does not call the provider again. If it had not reserved, the fenced owner may continue safely. Cancellation must still be absent in both the reservation CAS and the final admission check, closing the boundary-to-provider cancellation window as far as the provider facade permits.

The durable `EvalRun.attemptNumber`, not BullMQ's delivery counter, is the retry source of truth. `RETRY_SCHEDULED` rows are reconciled and published with a job ID for the next durable attempt; expired leases use a recovery ID containing the expired fence token, so successive takeovers cannot collide. A takeover increments the durable attempt while capacity remains. At the advertised maximum it retains that maximum attempt, replaces only the expired fence, and must finish terminally. Before any result insert—provider-backed or operational-only—the worker locks the exact active run row with tenant, venue, identity hash, durable attempt, unexpired lease token, and no cancellation. Result creation and reservation settlement then share that transaction, so stale holder A cannot commit after takeover B.

## Cancellation

Platform admins may request cancellation from the evaluation console. The operation is tenant/venue/run scoped, idempotent, and strictly audited in the same transaction as the state change. A queued run becomes terminal `CANCELLED` immediately. A running run records immutable requester/time evidence; the worker observes it between cases and before provider admission, preserves completed results, writes cancellation evidence for remaining cases, and closes the run as `CANCELLED`.

Cancellation cannot guarantee recall of a provider request already dispatched. No new case dispatch begins after the cancellation check observes the request.

## Migration and rollout boundary

`20260811235000_add_evaluation_run_lifecycle` is additive and transactional. It adds lifecycle fields, database checks, and a transition trigger that prevents terminal regression, decreasing attempts, changed max-attempt identity, or rewritten cancellation/completion evidence.

`20260824230000_add_reviewable_package_evaluation_snapshot` adds the reviewable-package discriminator. `20260824230100_allow_reviewable_package_evaluation_snapshot` then extends the existing snapshot-shape constraint in a separate migration so PostgreSQL commits the enum value before the constraint uses it. Both are forward-only local migration artifacts until the separately authorized staging migration gate runs.

The conversation-case preparation path requires no schema migration and does not connect to Redis, enable either feature gate, or call a provider. Tests use injected persistence and evaluation adapters; worker tests assert that no provider facade was invoked.

Before any authorized staging rollout, an owner must separately approve the exact environment, migration rehearsal/application, server gate, tenant flags, cost ceiling, and synthetic evaluation corpus. Staging proof for two venues and an intentional regression remains outstanding under the active database-incident boundary.
