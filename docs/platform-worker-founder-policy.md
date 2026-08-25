# Platform worker founder-policy access

Torchiko exposes founder policy, a compact company operating view, platform readiness, and exact
release-candidate evidence to future trusted internal workers through separate HTTP boundaries:

- `POST /api/platform-worker/founder-decisions` resolves exact current founder decisions.
- `POST /api/platform-worker/founder-operating-view` returns the bounded, versioned Founder
  Control Room projection, including descriptive autonomy evidence.
- `POST /api/platform-worker/operations-readiness` returns versioned database, migration, worker,
  and live BullMQ queue evidence.
- `POST /api/platform-worker/release-evidence` reads bounded immutable release history or records
  one schema-validated, append-only evidence bundle for an exact repository revision.

This is not customer MCP. Its credentials use a distinct `pf_platform_` token type and the closed
capabilities `founder-decisions:read`, `founder-operating-view:read`,
`operations-readiness:read`, `release-evidence:read`, and `release-evidence:record`. The record
capability can only append release evidence; it cannot execute a release. Credentials are issued
disabled, store only an Argon2id verifier,
require explicit platform-admin activation,
support explicit revocation, and strictly audit every successful read. Tenant, client, and venue
identifiers are intentionally absent from the credential and request contracts. A tenant MCP token
is rejected before credential lookup.

The request contains one to fifty unique stable decision keys. Resolution is exact and current-only;
there is no fuzzy fallback. Missing keys remain explicit. Ambiguous current truth returns a
fail-closed reconciliation response rather than guessing.

Credential issuance returns plaintext once. Exact replay returns no plaintext. Activation and
revocation use optimistic timestamps and idempotent operation IDs. No credential is issued or
activated by migrations, fixtures, or startup. Connecting a worker and storing its one-time secret
remain explicit owner-controlled operations.

The operating view accepts only a bounded row limit. It reuses the same canonical attention,
briefing, run, action, approval-decision, and outcome evidence as the Founder Control Room. Its
autonomy-evidence schema v3 reports per-agent-identity execution outcomes, approval acceptance,
quality evaluations, customer signals, exact-action rollbacks, explicit policy violations, and
confidence prediction/outcome pairs. It labels incomplete evidence windows, does not manufacture a
reliability score, claim exhaustive history, recommend approval reduction, or change permissions.

The operations-readiness request accepts no tenant, venue, queue, or job selector. Its v2 response
observes the complete canonical 20-queue inventory directly from BullMQ/Redis, reports bounded
state counts, aggregate depth, retained failed pressure, paused queues, schedulers, and oldest
nonterminal age, and includes no job identity, payload, or failure detail. A ready status requires
database and Redis connectivity, migration parity, a fresh worker heartbeat, and a complete live
queue observation. A failed or timed-out queue probe is explicitly degraded rather than green.
This evidence is platform-wide and intentionally has no tenant or venue attribution.

Release evidence binds an exact revision, repository cleanliness, named gate outcomes, limitations,
rollback instructions, and an optional staging handoff. Content hashes deduplicate identical
evidence, operation hashes make retries safe, database triggers reject update/delete/truncate, and
every successful read or record is strictly audited. A staging-ready record is rejected unless the
assessment is clean and has no failed or blocked gates. The Founder Control Room renders this same
canonical state with an explicit evidence-only label.

These endpoints cannot create questions, approve or acknowledge actions, change policy, retry,
cancel or redrive jobs, control incidents, contact customers, deploy, run migrations, authorize
production, destroy valuable data, or perform billing operations. No credential is activated
automatically.
