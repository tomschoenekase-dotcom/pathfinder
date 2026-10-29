# Provider health, model selection and answer provenance

## Passive guest generation health

`GET /api/health` and the existing authenticated `torchiko.integrations.health`
read expose `generation: { status, lastFailureCode, since }`. This observes guest
text-generation route outcomes; it is not a credit-balance query and does not
certify imports, embeddings or every other AI workload. No provider call is made
by reading health. Existing operator scope checks remain in force.

Quota exhaustion degrades immediately. Three failed terminal route invocations
among the latest five within five minutes also degrade. Internal retries count
as one terminal outcome. Two later consecutive successes on that provider/model
clear degradation and its old failure sample. Success on another model does not
clear it. Fifteen minutes without evidence becomes `unknown`, never healthy.
`since` is the observed transition time, not a provider-wide incident start time.

Redis observation is bounded and best effort: failures, malformed data and
timeouts cannot delay or reject a guest answer. The store has a 64-model cap and
three bounded compare-and-swap attempts; heavy contention can lose telemetry.
No provider routing, exclusion, budget or worker flags change automatically.
Infrastructure `ok`/HTTP status still reflects DB/queue readiness, so an external
outage cannot prevent deployment of a repair. Monitoring must inspect `generation`.
No email alert or recipient is added.

## Safe failure evidence

Provider logs retain only a numeric HTTP status and an allowlisted provider code,
plus a classified code such as `PROVIDER_CREDITS_EXHAUSTED`,
`PROVIDER_RATE_LIMITED` or `PROVIDER_UNAVAILABLE`. HTTP 429 alone does not prove
exhausted credits. Raw provider messages, headers, prompts and credentials are
never copied into those fields. Quota failures are not retried within a provider
invocation. Import summaries preserve receipt-recovery instructions and safe
classification. Customer-create receipts preserve safe identity-provider status
and code even after no-effect reconciliation; that evidence does not itself
prove an operation had no effect or authorize a retry.

## One venue, three model families

Read `venues.get_guest_model` with the venue and tenant IDs. Submit
`venues.propose_guest_model` using the same scope, a new `operationId`, and
`modelKey: "sol"`, `"terra"` or `"luna"`. These normalize to Sol Fast, Terra Fast
and plain Luna respectively. Existing canonical route keys remain accepted.
The existing approval policy applies unchanged. Use the returned revision for
optimistic concurrency and read back the effective model after the operation.
`venues.propose_guest_model_reset` removes that venue's model selection so its
effective value inherits the current default; it does not promise a fixed model.

Pending previews show current/new models and per-million-token price direction.
Applied receipts also report the comparison. Token rates do not predict actual
spend: context, cache, reasoning output, retries and fallback affect the total.
Setting a disabled override enables its stored timeout, attempts, fallback,
output and budget settings as well. The preview/readback warns explicitly.

`packages/contracts/src/guest-chat-model-registry.ts` is the single pure guest
model definition: route ID, provider/API model, label/aliases, Fast and reasoning
settings, timeout/limits, default fallback, versioned token prices and deployment
policy flags. Execution specs, public routes/capabilities, operator choices and
accepted deployment defaults derive from it. Add one entry and a regression test
for a future model on an existing provider. A new provider also requires its
adapter and provider policy. Hidden legacy routes keep their existing scope;
the health store does not maintain a second model list.

## Provenance and model comparison

The final NDJSON `complete.result` and ordinary chat result carry `requestId`,
`turnId`, `modelRoute`, and `providerFailureCode`. A new generated answer reports
the route that actually succeeded, including fallback. Deterministic answers and
historical replays use `modelRoute: null`: today's configuration must not be
attributed to an old answer. Failure logs correlate request/turn IDs and the
attempted primary route under `routeModel`. Do not confuse a failure's attempted
route with a successful answer's model. No persistent replay-metadata shape changes.

For a future authorized comparison, keep one question-file hash and package
hash, exact runtime revision, original model readback and two separate output
directories. First run `pnpm venue:answer-test --questions QUESTIONS.json
--offline PACKAGE.json --out NEW_OFFLINE_DIR` without paid calls. This verifies
fact presence only and cannot compare model behavior. For each separately
approved model, switch only the selected unshared venue, read it back, then use
the evidence lane's `venue:answer-test --questions QUESTIONS.json --url GUIDE_URL
--out NEW_MODEL_DIR`. Bind saved answers to the actual response route, health
revision, timestamp and request/turn IDs, and record grader identity separately.
Compare the same question IDs, failures and costs without treating delivery
errors as content grades. Restore the original selection through the same
canonical tool under the approved plan. No such live comparison is implied by
these instructions or performed by this change.

## Old-application rollback

The older production application `a18fde4b` cannot parse newer Fast/Terra/Luna-reasoning keys. The task base `3d858362` already supports those keys; rolling this patch back to that base does not introduce this compatibility issue. This
code cannot change the already-built old binary. Before rollback, retain a
snapshot of effective AND stored model keys at every scope, including disabled
rows and fallback arrays. Use the candidate's canonical configuration actions
with expected revisions to apply an explicitly approved normalization plan,
then validate old-app reads before changing deployment. Plain Sol and plain Luna
are old-supported choices; Terra Fast has no equivalent old Terra route. Do not
silently change spending or rewrite model settings automatically. Preserve the
original snapshot for a later forward restoration.
