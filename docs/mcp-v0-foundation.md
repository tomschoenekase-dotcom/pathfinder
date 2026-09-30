# PathFinder MCP v0 foundation

Status: local candidate implementation; dark and not admitted to hosted staging or production.
Disposable PostgreSQL proves the local migration and credential/tool lifecycle. No hosted migration,
deployment, or feature activation has been performed for this candidate.

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

`packages/api/src/mcp/read-actions.ts` provides the read adapter for the registry's injected `read`
seam. The dashboard MCP handler supplies a database-verified credential context. Direct callers of
the registry must still supply a verified context; tool arguments never establish authority.

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
- venue- and client-scoped external access credential capability/state/expiry/last-use metadata
  without secret hashes, secret prefixes, or rotation material;
- agent-run status/model/attempt/cost/lineage metadata without request prompts, frozen scope
  snapshots, artifacts, provider errors, or initiating-user identifiers;
- operational attention events and recommended recovery actions without delivery destinations;
- native deployment lifecycle metadata without plans, state snapshots, replacement universes, or
  hashes;
- tenant feature-flag keys/state without metadata or setter identities;
- derived readiness counts/state plus exact native-head convergence phase, blockers, and safe
  counts without state hashes, native snapshots, configuration blobs, read switching, or legacy
  retirement authority;
- venue-scoped agent questions and operator responses without credential or raw execution data; and
- explicit venue-scoped agent outcome observations without operation IDs or human actor identifiers; and
- versioned venue-scoped agent improvement proposals with exact outcome IDs and review state, without operation IDs or reviewer identifiers.
- immutable approved-proposal validation evidence with implementation version/hash and sanitized same-corpus before/after comparison, without reviewer identifiers or automatic promotion.

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

The dashboard composes the adapter and registry into a stateless JSON-RPC POST handler. The route is
available at `/api/mcp/{tenantId}` for client-scoped credentials and
`/api/mcp/{tenantId}/{venueId}` for an exact venue credential. `AGENT_BRIDGE_HTTP_ENABLED` is
default-off. The handler verifies the current bearer credential against its stored hash and exact
tenant/client/venue scope, applies protocol, origin, body-size, and rate limits, then dispatches to
the registry. MCP's 2026-07-28 discovery metadata endpoint and OAuth authorization/token flow are
not implemented; this transport accepts the existing manually issued bearer credentials.

`MCP_WRITE_TOOLS_ENABLED` is also default-off. It gates the separate venue interaction mutations
`torchiko.venues.create` and `torchiko.appearance.update`; reads and review-only interactions do not
turn it on. Approval-required tools retain their exact approval checks.

`torchiko.agent_improvements.propose` is a review-only interaction. An exactly scoped worker may
prepare an outcome-backed hypothesis for human review. The tool pauses the proposing run and records
evidence, but cannot alter prompts, routing, models, tools, permissions, or production behavior.
Approval accepts the proposal for separately validated implementation; it is not an execution grant.

`torchiko.agent_improvements.record_validation` appends evidence only after an exact human approval.
It binds the approved proposal to an immutable implementation reference and two completed, exact-scope
evaluation runs. Corpus and evidence mismatches fail closed; content, model, or configuration changes
must be declared. The tool records no promotion and leaves behavior and authority unchanged.

## Gated venue appearance work

The forward database migration `20260930100000_add_mcp_venue_appearance_capabilities` admits
`appearance:read`, `appearance:write`, and `venues:create` for future MCP credentials. `venues:read`
was already admitted. The migration replaces the current credential evidence trigger while retaining
its sorted-and-unique capability check, separate partner allowlist, issue/rotate receipt requirement,
exact activation evidence requirement, and revocation timestamp evidence requirement. Client-scoped
activation is limited to tenant-equals-client credentials with null `venueId`, scope key `__CLIENT__`,
and a non-empty subset of `venues:read`, `venues:create`, `appearance:read`, and `appearance:write`.
Venue-scoped agent bridge activation still requires `agent-runs:execute`. The migration does not
change, enable, activate, rotate, or revoke existing credentials, and it does not enable an MCP tool.

An authenticated platform admin uses the existing admin tRPC router to issue and activate a
client-scoped credential. First call `admin.issueExternalCredential` with `tenantId` and `clientId`
equal, `venueId: null`, a fresh `operationId`, `kind: "MCP"`, an expiry, and only the needed
capabilities. Issuance returns a disabled credential and its plaintext once. Then call
`admin.activateClientMcpCredential` with the same tenant/client, `venueId: null`, a second fresh
`operationId`, the returned `credentialId`, the returned `updatedAt` as `expectedUpdatedAt`, and the
exact capabilities returned at issue time. Activation uses compare-and-swap and durable evidence;
it never returns plaintext. Keep the bearer value in the approved secret manager/client setup only;
never put it in command arguments, shell history, logs, source, or this document. Revoke through
`admin.revokeExternalCredential` when access is no longer needed.

After the candidate clears the hosted release gates, a client sends an HTTP POST to
`<approved-staging-dashboard-origin>/api/mcp/<tenantId>` with `Authorization: Bearer <issued-secret>`,
`Content-Type: application/json`, and `Accept: application/json, text/event-stream`. A client-scoped
credential cannot use a venue route. Appearance tools also require
the separately reviewed `MCP_WRITE_TOOLS_ENABLED` rollout; leave both MCP route and write flags off
for migration-only and initial code-only verification.

Release B remains dark until a reviewed exact 40-character release SHA passes CI and staging
admission. This appends migration 253, while the current preserved-data predeploy contract and image
approval pin admit only through migration 252. The next gate is a release-specific owner review that
updates the accepted migration boundary and matching web-image pin for 253, plus a fresh
release-bound backup and successful restore rehearsal for the actual staging lineage. Do not substitute
synthetic-data approval: staging may contain preserved production lineage.
The checked-in token `torchiko-staging-lineage-to-252-20260927` still admits only 252; it does not
admit 253. Update `scripts/lib/staging-migration-admission.mjs`, `scripts/staging-release/migration-policy.mjs`,
and `Dockerfile.web.staging` together only after that release-specific review is approved.

Use the preserved-data route for any hosted migration; freeze the approved SHA, pause application
autodeploy without deploying, drain writers, and retain the release-bound backup and restore proof.

1. In the staging provider, set the approved migration token and web-only
   `PATHFINDER_ALLOW_STAGING_MIGRATIONS=1` plus
   `PATHFINDER_STAGING_MIGRATION_ONLY_HOLD=1` with `--skip-deploys`; leave dashboard and workers
   stopped. The token must match both the reviewed migration boundary and web image pin.
2. Run `pnpm db:migrate:staging` from the exact approved web release. Retain the held migration
   receipt and accept its exact database readback. The expected result is
   `migration-verified-application-held`; it is not a healthy application deployment.
3. After readback acceptance, set both migration values to `0` with `--skip-deploys`, deploy web
   again at the same frozen SHA, and run `pnpm verify:staging-health` plus the exact-SHA topology
   admission in `docs/railway-staging.md`. Release dashboard and workers at that SHA only after web
   health passes; then require all three services to pass staging admission.
4. Keep `AGENT_BRIDGE_HTTP_ENABLED` and `MCP_WRITE_TOOLS_ENABLED` off during migration and initial
   code-only verification. Enabling the route and later the write flag requires separate reviewed
   staging rollout evidence.

Production remains behind the active incident stop. It requires a separate release-specific
production migration/cutover approval after exact-SHA staging evidence; staging approval does not
authorize production migration or deployment.

## Deliberate limitations

- The dashboard has a stateless MCP JSON-RPC POST transport, but MCP 2026-07-28 discovery metadata
  and OAuth authorization/token endpoints are not implemented. The bearer credential lifecycle is a
  platform-admin operation, not OAuth enrollment or consent.
- The HTTP routes, registry composition, credential issue/activate/revoke lifecycle, and migration253
  have local test coverage, including a disposable PostgreSQL end-to-end proof. This candidate has no
  hosted migration, deployment, hosted adversarial exercise, or write-flag activation.
- Client-scoped MCP activation is limited to venue identity/list/create and visitor appearance
  read/update capabilities. Venue agent bridge activation remains a separate venue-scoped contract.
- Approval-required tools retain exact approval evidence and canonical approval verification. Those
  checks do not enable the separately default-off HTTP route or venue write feature flag.
