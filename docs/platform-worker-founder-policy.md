# Platform worker founder-policy access

Torchiko exposes founder policy, a compact company operating view, and platform readiness evidence
to future trusted internal workers through separate read-only HTTP boundaries:

- `POST /api/platform-worker/founder-decisions` resolves exact current founder decisions.
- `POST /api/platform-worker/founder-operating-view` returns the bounded, versioned Founder
  Control Room projection, including descriptive autonomy evidence.
- `POST /api/platform-worker/operations-readiness` returns versioned database, migration, worker,
  and live BullMQ queue evidence.

This is not customer MCP. Its credentials use a distinct `pf_platform_` token type and the closed
read-only capabilities `founder-decisions:read`, `founder-operating-view:read`, and
`operations-readiness:read`. Credentials are issued disabled, store only an Argon2id verifier,
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
autonomy-evidence schema v2 reports per-agent-identity execution outcomes, approval acceptance,
quality evaluations, and customer signals. It explicitly labels rollback rate, policy violations,
and confidence calibration unavailable until canonical evidence exists; it does not manufacture a
reliability score, claim exhaustive history, recommend approval reduction, or change permissions.

The operations-readiness request accepts no tenant, venue, queue, or job selector. Its v2 response
observes the complete canonical 20-queue inventory directly from BullMQ/Redis, reports bounded
state counts, aggregate depth, retained failed pressure, paused queues, schedulers, and oldest
nonterminal age, and includes no job identity, payload, or failure detail. A ready status requires
database and Redis connectivity, migration parity, a fresh worker heartbeat, and a complete live
queue observation. A failed or timed-out queue probe is explicitly degraded rather than green.
This evidence is platform-wide and intentionally has no tenant or venue attribution.

These endpoints cannot create questions, approve or acknowledge actions, change policy, retry,
cancel or redrive jobs, control incidents, contact customers, deploy, or perform billing
operations. No credential is activated automatically.
