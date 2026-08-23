# PathFinder MCP v0 foundation

Status: contract and adapter foundation only; dark and not deployable.

This foundation targets the official MCP protocol revision `2026-07-28`:

- <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>
- <https://modelcontextprotocol.io/specification/2026-07-28/schema>

The shared catalog is in `packages/contracts/src/mcp-v0.ts`. It describes deterministic resource
templates and a deliberately narrow tool set. Every definition carries explicit PathFinder scope,
capability, tenant/client/venue binding, effect, risk, default-enable, and approval metadata.
Standard MCP tool annotations remain conservative. Tool results include validated
`structuredContent` and the same serialized JSON in a text content block for backwards
compatibility.

The server-only registry is in `packages/api/src/mcp/registry.ts`. It validates input, verified
credential scope, capability grants, approval presence, and output around injected canonical domain
actions. It does not implement business logic or accept tenant authority from arguments.

## Concrete read bindings

`packages/api/src/mcp/read-actions.ts` provides the transport- and authentication-neutral read
adapter for the registry's injected `read` seam. The embedding server must still supply a verified
credential context; this adapter does not issue, verify, enable, rotate, or revoke credentials.

Every query reapplies the exact verified tenant/client/venue scope. In the current data model,
`clientId` is the tenant ID, so the adapter fails closed unless `tenantId`, `clientId`, the request's
`clientId`, and (for venue resources) an allowed `venueId` agree. Requests are bounded to 100 rows.
Pagination uses deterministic resource-bound opaque cursors; cursors carry ordering state only and
never authority.

The bindings expose:

- safe client and exact-venue identity/lifecycle fields;
- partner-safe venue presentation configuration (never tenant configuration blobs, guide notes, or
  raw logo/banner URLs);
- active places and enabled knowledge entries without raw source or media URLs;
- content-history envelope metadata without before/after snapshots or provenance payloads;
- package lifecycle metadata without package payloads, preview plans, or validation reports;
- support request lifecycle metadata without artifacts, messages, attachments, audit actors, or
  internal notes;
- operational update fields without raw redirect URLs;
- bounded daily AI usage/cost summaries;
- job lifecycle metadata only when the record's internal payload has an exact matching `venueId`;
  the payload and error text are never selected or returned, and unmarked jobs are invisible;
- evaluation lifecycle/model/budget metadata without errors, corpus, model, run-config, identity,
  package, or content snapshots;
- weekly-report lifecycle/count/publication metadata without report content or error text;
- privacy-bounded visitor session metadata without anonymous tokens, visitor identifiers,
  coordinates, or message content;
- venue-scoped external access credential capability/state/expiry/last-use metadata without secret
  hashes, secret prefixes, or rotation material;
- agent-run status/model/attempt/cost/lineage metadata without request prompts, frozen scope
  snapshots, artifacts, provider errors, or initiating-user identifiers;
- operational attention events and recommended recovery actions without delivery destinations;
- native deployment lifecycle metadata without plans, state snapshots, replacement universes, or
  hashes;
- tenant feature-flag keys/state without metadata or setter identities;
- derived readiness counts/state without configuration blobs;
- venue-scoped agent questions and operator responses without credential or raw execution data; and
- explicit venue-scoped agent outcome observations without operation IDs or human actor identifiers; and
- versioned venue-scoped agent improvement proposals with exact outcome IDs and review state, without operation IDs or reviewer identifiers.

## Agent-to-operator interaction

`pathfinder.ask_operator` is the first live domain binding beyond reads. An enabled, in-scope agent
can create an idempotent question using an operation UUID, optionally attach it to an active run,
offer up to eight suggested answers, and mark it blocking. A blocking question moves a queued or
running run to `AWAITING_INPUT`. It is a low-risk interaction tool: it cannot approve, execute,
publish, or change venue content.

Platform admins answer or dismiss questions in the Agent workspace. Responses use optimistic
concurrency, write audit and timeline evidence, and return a blocked run to `QUEUED`. When the
durable runner feature gate is enabled, the response endpoint idempotently enqueues that eligible
run and reports whether dispatch actually occurred; it never claims execution when the runtime is
paused.

The adapter is exported by `@pathfinder/api/mcp`, but nothing instantiates it in a listener. Write
actions remain injected separately and default-off at the registry boundary.

`torchiko.agent_improvements.propose` is a review-only interaction. An exactly scoped worker may
prepare an outcome-backed hypothesis for human review. The tool pauses the proposing run and records
evidence, but cannot alter prompts, routing, models, tools, permissions, or production behavior.
Approval accepts the proposal for separately validated implementation; it is not an execution grant.

## Deliberate limitations

- No MCP network listener, transport, `server/discover` handler, HTTP headers, or protocol request
  dispatcher exists.
- No OAuth/credential issuer, token validation, Clerk adapter, API-key persistence, or authorization
  server exists. The registry requires a credential scope already verified by the embedding server.
- The agent-question schema and migration are implemented locally, but no migration was applied to
  any external or production database.
- Concrete bounded read actions are available, but no deployment composition root currently injects
  them into a transport. Draft/evaluation write actions remain unbound.
- Draft/evaluation tools are disabled unless the embedding server explicitly enables them, and every
  such call additionally requires opaque approval evidence and invokes an injected canonical approval
  verifier for the exact tool, capability, client, and venue. Draft tools cannot publish or apply changes.
- Resource reads are not production-ready until transport authorization, current-credential checks,
  audit events, rate limits, and staging adversarial evidence exist. Evaluation execution remains
  separately default-off.
