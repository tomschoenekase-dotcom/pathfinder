# Provider evidence package

`pnpm provider-evidence:validate -- <package.json>` validates a bounded, reviewed record of the
provider-backed staging work still required by `VIS-02`, `VIS-04`, `VIS-05`, `PERF-01`, `BLD-05`,
and `AI-01`.

The command is read-only. It never reads a credential, calls a provider, runs an evaluation, changes
routing, deploys, contacts a customer, or certifies launch. The provider work must already have been
performed through the governed staging product surfaces under an explicit founder-approved provider
list, authenticated administrator session, isolated staging credential, expiry, and dollar ceiling.

The package requires exact release identity; a synthetic non-customer venue; retained run, prompt,
corpus, provider, model, reservation, observed-cost, and timing facts; BRIEF/BALANCED/DETAILED review;
the exact 20-case ten-language run; a founder-approved live voice canary and text fallback; streaming
TTFT evidence; 100 Golden Venue observations with completed human review; and an OpenAI same-corpus
model-diversity observation. Anthropic evidence is optional and cannot authorize a routing change.

The receipt contains only exact release identity, scope, observed provider names, aggregate counts and
costs, false launch/routing authority, and a stable package hash. It omits private review references,
response content, transcript content, identifiers, and credential material. The checked-in pending
template is intentionally incomplete and must fail until genuine approved evidence replaces it.
