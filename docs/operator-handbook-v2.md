# PathFinder operator handbook v2

This handbook describes the intended operator workflow for PathFinder OS and the Internal Client
Workspace. It does not authorize live database or production work. The active boundary in
`docs/database-incident-stop.md` always wins.

## Operating principles

1. Establish client and venue scope before reading or changing anything.
2. Preserve source evidence and distinguish client-visible material from internal notes.
3. Prefer a draft, preview, evaluation, and approval over a direct production effect.
4. Treat ambiguous mutation outcomes as unknown until authoritative state is reloaded.
5. Never represent a queued job, recorded approval, or generated proposal as applied work.

## Create a client and venue

Use **PathFinder OS → New client**. Confirm the canonical organization name and whether the client
has one or multiple venues. A single venue should remain invisible as hierarchy in the portal.
Creation is not publication; verify membership and venue readiness in the Internal Client Workspace.
Venue identity/configuration edits require the displayed revision. Automatic slugs are allocated
under a tenant lock and must remain nonempty and addressable. Initial Place/Knowledge embeddings are
dispatched only through the durable database outbox. Venue deletion is owner-only and should remain
a last resort; use availability/offboarding controls for ordinary deactivation.

## Onboarding and intake

Clients supply modest raw inputs: URLs, documents, media, and answers. Operators inspect the source,
evidence, uncertainty, contradictions, privacy classification, and proposed content mapping. Website
intake is bounded and cited. Staff interviews are text-only and consent-gated. Intake output is a
draft proposal; it must not auto-approve or auto-publish.

The shared intake proposal service is the authoritative persistence seam for both tenant and
platform-admin adapters. It enforces exact tenant and venue scope, preserves consent and privacy
evidence, and may link only an existing same-scope `DRAFT` package through append-only lineage.
Withheld source material remains evidence, not client-visible candidate copy. The service does not
create, approve, apply, or publish a package.

For a staff interview, select the participant's role and record written answers only. Every prompt
must be answered, explicitly skipped, or redacted; mark uncertainty and confidence deliberately and
obtain the displayed consent before submission. Do not paste private or internal text into a public
candidate answer. The review shows each typed candidate field, safe withheld/redacted status,
confidence flags, consent evidence, and an event timeline. “Handoff-ready” means only that public
candidate fields and local review checks are present; an operator must still use the separate
reviewed-DRAFT workflow. It is not approval, apply, publication, format validation, or malware
verification. If a submission response is ambiguous, retry the unchanged form so its durable request
identity can converge; edit the form only when intentionally creating a new canonical submission.

When a structured-bootstrap or interview review is handoff-ready, load the server-built package
candidate, inspect its read-only JSON, and explicitly create the `DRAFT`. The server rebuilds the
same candidate and replay identity inside the canonical final transaction. Never copy intake text
into the generic JSON form or attach an unrelated existing draft; those legacy linkage paths are not
exposed. Website and quarantined-file intake remain proposal/evidence only in this foundation.

Reviewed DRAFT creation uses one stateless package service for tenant managers/owners and exact-scoped
platform administrators. It records the real HUMAN role; admin creation does not impersonate a
tenant member. Support/intake linkage is an explicit same-transaction finalizer, not hidden router
state. A DRAFT still requires separate lifecycle review.

## Read the client lifecycle

The portal lifecycle is a read model derived from current scoped evidence, not a status operators
advance manually. When a client asks why they see a milestone, inspect the venue, intake, package,
availability and offboarding evidence in the Internal Client Workspace. Correct the authoritative
workflow evidence through its approved action; do not edit or promise a lifecycle label directly.

Use the Internal Workspace compatibility-content view only for existing Place and Knowledge records.
It is an operator migration bridge, not the generalized content model and not a client-facing tool.
Create, edit, and soft-retire operations retain drafts on conflict and require an authoritative
refresh before retry.

## Review, preview, and publish

Review granular changes at venue scope. Validate references, provenance, capability compatibility,
and evaluation/readiness evidence. Preview the guest experience before approval. Approval records a
decision; it does not itself execute a package or agent action. Apply through the existing package
lifecycle only after the reviewed revision and scope are exact.

For Venue Deployment Manifest v2, use Internal Workspace review to inspect the canonical hash,
exact FULL base, safe evidence references, all seven coverage sections and materialization issues.
Review is read-only. **Record immutable artifact** appends exact review evidence. When and only when
a PATCH is marked `MATERIALIZABLE`, recording also atomically creates or replays its linked
compatibility `DRAFT`; that is not approval or application. FULL and unsupported PATCH results are
`NOT_MATERIALIZABLE`, record artifact evidence only, and expose no draft handoff. Never treat an
artifact, coverage report or linked `DRAFT` as permission to approve, apply, publish or call a
provider.

The FULL projection on that screen is a different read-only candidate. Supply fresh manifest
and idempotency UUIDs, review the canonical hash and every omission, then download only the artifact
bound to that envelope. Editing either UUID or a failed regeneration invalidates the prior download.
The projection is always `NOT_READY`: it reads safe current venue configuration, not an immutable
publication snapshot, and omits generalized modules, immutable assets, capabilities, model
references, and readiness evidence. It cannot create or apply a package; recording the subsequently
reviewed FULL contract still produces only a `NOT_MATERIALIZABLE` immutable artifact.

Migration `20260812000800_add_venue_package_manifest_artifacts` remains unapplied. The local screen,
schema validation and focused tests are not evidence that artifacts or linked drafts exist in a live
database.

Guest previews may include callouts, actions, citations, choices, images, galleries, events, and
locations as well as legacy text and place cards. Reject unknown block types. Image and map links
must be HTTPS and must not contain credential- or secret-like parameters. A safely rendered block
is still only a preview; it does not prove that a remote asset is approved, durable, or live.

For **Client preview**, open the authenticated package preview rather than the ordinary guest URL.
It is bound to one exact `APPROVED` package and shows a bounded effective V1/V2/V3 visitor candidate:
public branding and guide tone, Places with public coordinates, and Knowledge. **Superseded** means
the venue base changed after approval; **Unavailable** means no eligible package exists or retained
evidence cannot be represented safely. Neither state publishes, applies or exposes the preview
publicly. Do not describe this static view as the live guest experience.

## Rollback

Use versioned package or content-history rollback controls. Confirm the target version, venue, actor,
and resulting version. Do not perform direct database rollback. An ambiguous result requires a fresh
authoritative read before retry.

## Support

Client-visible messages and internal notes are separate visibility classes. Never copy private or
internal evidence into the client thread. A support request may result in a package patch, but the
patch still follows validation, evaluation, preview, approval, and apply boundaries.

A tenant role does not open every request. `STAFF`, `MANAGER`, and `OWNER` have identical client-side
access: a person must be the immutable requester or an explicitly granted, unrevoked participant,
and their tenant membership must still be active. An authorized teammate is labeled `Your team`;
the ordinary client projection does not expose requester or participant identities. The requester
alone can open the bounded **Conversation access** manager, page active organization members, and
grant or remove access with the displayed conversation version. Participants cannot enumerate or
manage the roster. A successful change forces an authoritative refresh before another action; after
an ambiguous result, retry the unchanged operation identity, and after a conflict refresh rather
than guessing. Revocation removes future access without deleting durable grant/revocation evidence.

The verified package-lineage action can attach an exact support request version to an existing
same-client, same-venue `DRAFT` package. Confirm both scopes, request version and target package
before linking. The link is append-only and auditable; it neither changes package status nor marks
the support request complete. Status-transition controls expose only allowed next states. Transitions
require the displayed request
version/current status and may conflict if another operator acted first; reload before retrying.
`VALIDATING` includes validation/evaluation review in the current persisted vocabulary. Moving a
request to `APPLYING` or `COMPLETED` records workflow state only and never executes a package.

Support file references remain quarantined evidence. Upload verification confirms the stored object
version, declared MIME, size and checksum; it does not establish readability, format safety or
malware safety. Do not preview, download, approve or reuse the bytes as content from the Support
surface. Client pickers show only that user's exact-venue uploads awaiting PathFinder review;
participants do not inherit the requester's uploads, and each teammate may attach only their own
eligible evidence. Operators may select exact-venue eligible evidence through the separately
authorized Internal Support surface. On an ambiguous send result, retry the unchanged draft so its
retained operation identity can converge. Edit the message or selection only when you intend to start
a new operation.

Client-visible replies, participant changes, and client-authored messages use the displayed
`clientVersion` and update client activity ordering. Internal-only notes and operator workflow use the
separate global request version and must not make an old request look newly active to the client.
Refresh after a conflict rather than substituting one version for the other. Platform administrators
can inspect both visibility classes only through the exact-scoped Internal Support console; tenant
membership or a tenant role is not a substitute for that admin boundary.

Feedback submitted from an approved package preview creates a Support request with immutable lineage
to that exact tenant, venue and package. Reuse its operation UUID after an ambiguous result only
while package, text and selected verified attachments are unchanged. The server rechecks that the
preview remains current before recording it. Feedback never edits or advances the package and cannot
approve, apply, publish or trigger provider work.

Use support triage to assign a category and a concise missing-information checklist before changing
workflow state. Triage requires the displayed request version, retains selections on a conflict,
and records one audited revision. It does not message the client, change status, create a package,
or apply content; communicate deliberately through the separate message composer.

To request information, use the dedicated prompt action only while the request is `OPEN` or
`IN_REVIEW`. Review the displayed version, write the client-visible prompt, and list the exact
missing items; success moves the request to `WAITING_FOR_CLIENT`. An authorized requester or active
participant can respond from that state, optionally with only their own eligible quarantined
attachments; the response clears the checklist and returns the request to `IN_REVIEW`. Manual
completion is separate: it is available only for an `OPEN` or `IN_REVIEW` request with no missing
items and always records an explicit client-visible completion message. These actions record
versions and audits only. They do not create or apply a package, run an agent, or call a provider.
After an ambiguous result, retry the unchanged operation identity; after a conflict, refresh.

An Internal Support operator may append evidence that an exact request audit version relates to one
existing terminal AgentRun in the same tenant and venue. Confirm the displayed request version and
terminal run identity/status before linking. The link records the run's terminal status and
completion time immutably; it does not create, start, resume, cancel or otherwise change the run,
does not decide an approval, and does not execute Support or package work. Lineage is read from the
Support request in this build; the AgentRun screen has no reverse backlink. Do not infer that an
unlinked run is unrelated, or that a link proves provider or live execution quality.

The portal task checklist is bounded and uses the same requester/participant ACL. It shows at most
five missing details for a request plus a remaining count. Staff-answer review shows only safe
sharing choices and retained/public text; confidence, discrepancies, readiness, timelines and
internal evidence are admin-only. Client errors remain plain and nondisclosing.

The Internal Workspace package page exposes deliberate `DRAFT` → `APPROVED` → `APPLIED` →
`REVERTED` controls to a platform administrator. Review the exact stored payload and every warning,
acknowledge the displayed payload/warning evidence before approval, confirm apply or revert, and
wait for the authoritative readback before taking the next action. Tenant-side lifecycle authority
remains HUMAN `OWNER`; the Internal Workspace records the real HUMAN `PLATFORM_ADMIN` instead of
impersonating that owner. A repeated matching command by the same actor is a replay; a changed
revision, actor or reused command key is a conflict. Existing V1/V2/V3 rollback behavior remains
distinct—do not assume the richer V3 lineage rules apply to legacy packages. These controls do not
publish, invoke a provider or prove a live deployment.

Use Guest design only from the exact venue's Internal Workspace. It records the real platform
administrator and requires the displayed revision. You may keep an already reviewed logo/banner or
clear it, but cannot enter or upload a new reference. The style card is illustrative, not a literal
guest transcript; clients retain only their simple tone control.

Weekly Reports appears in client navigation only when at least one venue in the authorized workspace
has reports enabled. If availability cannot be checked, navigation remains hidden. The Reports page
shows published summaries for enabled venues only; a disabled venue fails closed without reading
its reports, and a missing or cross-scoped detail is not found. An invalid older-reports link resets
to the newest page with a visible explanation. Do not interpret the route or navigation as evidence
that scheduling, provider generation, delivery or notifications ran live.

## AI configuration and budgets

The global incident control and venue admission checks are hard stops. Cost budgets reserve before
provider dispatch and remain conservative after ambiguous failures. Model identity, prompt identity,
content identity, cost, and failure evidence must remain visible to operators. Do not bypass the AI
gateway or retry a provider call merely because usage persistence failed.

The AI workload view reports each effective field and its platform/workload/client/venue source. A
platform administrator can deliberately stage a venue override; new rows remain disabled unless the
operator explicitly enables them, every edit requires a reason and current revision, and reset leaves
an audited tombstone. Spend-expanding or model-selection changes require the separate unsafe-change
acknowledgement. Saving configuration never calls a provider and does not replace the runtime budget
gate. Do not copy a displayed registry value into an ad hoc provider call.

Changing Global AI requires an internal reason and the displayed revision. An identical submission
is a replay; a stale revision or concurrent first write is a conflict and requires an authoritative
refresh. A malformed stored control displays fail-closed and may only be repaired through an
explicit pause. The audited control write itself performs no provider or queue operation.

Workers renew generation leases before and during long provider calls. Ownership loss aborts the
call through its signal, treats dispatched cost as ambiguous, and suppresses redispatch. User
cancellation and takeover are distinct; never force a stale terminal write after either fence
rejects. This is locally tested behavior, not a live provider claim.

## Search and help

Use Cmd/Ctrl-K in PathFinder OS to search the bounded authorized groups for clients, venues, content,
support, agents, jobs, packages and evaluations. Search is navigation, not evidence that an operation
succeeded. The client portal consolidates help at Support; `/help` and advanced legacy client routes
redirect to an approved simple destination rather than rendering internal tools.

## Agent runs and approvals

Access scope and autonomy are independent. Inspect the run timeline, action summaries, version refs,
cost, errors, and approval request. Recording an approval never implies execution. Disabled or
read-only identities remain unable to act even when an approval exists.

The staged identity editor may create an identity only in the disabled state, edit it only while it
remains disabled with the current revision, or disable an already enabled legacy identity. It has no
enable, run, provider, model, or credential control. A saved identity is configuration evidence, not
evidence that an agent executed.

## Evaluations and freshness

Evaluation runs freeze case, model, prompt, and content identities. Separate operational failures
from scored quality failures. Freshness queues identify overdue trusted review, provenance gaps, and
date-sensitive updates; they do not assert factual contradiction and never auto-publish a patch.
An operator may confirm an active Place or Knowledge record as current and optionally repair safe
provenance metadata. Review records attribution only; it does not edit factual content. Never paste
signed, tokenized, credential-bearing, or encoded-secret source URLs—the action rejects them.

New evaluation requests remain `STAGED` until the default-off process gate, durable global gate, and
tenant gate all admit dispatch. The reconciler advances durable state before deterministic queue
publication and repairs queued publication gaps. `LEGACY` runs are intentionally non-runnable;
`RETRY_SCHEDULED` is not active execution. Cancellation records audited intent and uses lifecycle
CAS, but none of these local controls is provider or staging proof.

Compare only two compatible frozen runs. `INCOMPARABLE` means corpus, content/package, model/config,
manifest, case hash/revision, or result evidence did not match. Per-case classifications and deltas
are evidence, not a release gate. A human platform administrator may append a replay-safe conclusion
only after the candidate run is `COMPLETED`; refresh on conflict. A conclusion neither approves nor
blocks a package and cannot enable a gate, queue work, or call a provider.

## Universal content and MCP reads

Generalized Service, Policy, Event, Operational Fact, and Relationship modules are independently
versioned. Create, revise, and retire only through the default-off typed workbench; authoring a
`PUBLIC` revision does not publish it. Explicit publish requires the displayed latest revision and a
fresh request UUID; withdrawal requires the displayed published revision. Conflicts require refresh,
not blind retry. Guest chat resolves only effective latest publication-ledger state while the
generalized capability flag is enabled. The publication migration remains unapplied, so local
operator and resolver tests are not live guest evidence.

MCP v0 has concrete bounded read bindings for its 12 resource types. They use verified scope,
resource-bound cursors, explicit safe selects, and output leakage filtering. There is still no MCP
listener, credential issuance/verification, OAuth, or live authentication path; do not describe the
bindings as an externally reachable service.

## Guest chat retry and reconciliation

The guest client assigns one operation UUID to an unchanged message and retains the complete input
for an ambiguous transport retry. A successful replay returns the already committed response without
another provider call. `TOO_MANY_REQUESTS` and transient unavailability may retain the same frozen
operation. A terminal `PRECONDITION_FAILED` means provider work could not be safely committed: the
client removes the unpersisted optimistic turn, reloads authoritative history and requires a new
operation UUID for any deliberate resend. Never tell a guest that the old operation can still finish.

History is ordered by durable session sequence, not client or server clock. Engagement question and
answer state commits atomically with the visible message pair. Guest analytics resolves the browser
token to the exact internal venue session. New question-derived events reference the exact stored
user message; metadata has no raw-question fallback. Workers read text transiently through that
relation and skip unattributed legacy events. Operators should not expect bearer tokens or raw
questions in analytics rows or logs. Migrations `20260812000400_add_durable_guest_chat_turns` and
`20260812000700_add_analytics_user_message_attribution` remain unapplied; no live provider or
database behavior was exercised.

## Operational updates

Use plain language, explicit venue scope, start and expiry times, and preview. Review current,
scheduled, expired, and historical versions. Expired updates should not remain guest-visible.

Create, update, schedule, and deactivate through the canonical HUMAN manager/owner action. It
enforces venue/place scope, content-version entity and capacity locks, expected `updatedAt` CAS,
valid time windows, the bounded overlap limit, and transactional audit evidence. On conflict,
reload authoritative state before retrying. A locally computed `SCHEDULED`, `LIVE`, `EXPIRED`, or
`INACTIVE` preview is lifecycle evidence only; it is not proof that a live scheduler ran.

Content-history revert uses the version ID visible when the review opened as a concurrency fence.
If it reports a conflict, reload history and review the newer state; do not retry the stale command.
Managers may revert content within an existing venue, while restoring or removing a venue requires
an owner. Invalid or cross-scoped legacy snapshots fail closed rather than being partially applied.

## Failures and incidents

Start in **PathFinder OS → Operations**. Determine whether the issue is AI admission, a durable job,
evaluation, support workflow, venue availability, or deployment state. Prefer reversible controls.
Database assessment, remediation, restore, migration, promotion, and incident-stop changes require
the exact authorizations documented in the incident runbook.

Local query bounds, pagination and loading states improve perceived performance, but there is no
production-like latency evidence in this continuation. Record observed slow paths with exact scope
and route; do not infer database health from a locally passing component test.

A weekly digest must have a durable tenant/week intent before queue publication. A `PENDING` intent
may be queued again; `PROCESSING` and `COMPLETE` must not be re-enqueued. Retrying `FAILED` first
performs the audited CAS reset to `PENDING`, then the queue layer redrives a retained failed job under
the deterministic digest ID and confirms concurrent queue state. If durable preparation or queue
confirmation fails, record the failure and do not manufacture success. No live scheduler, Redis,
worker, delivery channel, or provider run is claimed by the local evidence.

Weekly-report history is bounded and cursor-paginated. Invalid date or cursor parameters fall back
to the recent range and newest page with a visible warning instead of failing the route. When a
report is terminal `FAILED`, use its detail-page retry control: it creates a new request identity
bound to that failed report and never mutates the failed evidence. If that new retry's outcome is
uncertain, retry unchanged from the same control so its new identity is reused safely.

## Offboarding

Create a requested plan only after confirming venues and required revocation targets. Current local
code records plans, targets, evidence, and export metadata but intentionally does not execute
revocation or deletion. Retention and support-history handling require owner/legal policy.

The draft form keeps one request UUID when an unchanged submission must be retried after an uncertain
response. The server returns the same plan for the same normalized intent and rejects reuse of that
UUID for different input or a different actor. A deliberate second plan therefore requires a new
request UUID; changing the selected venues in the form creates one automatically.

The export-manifest preview is metadata-only and bounded to 20 selected venues. Review its explicit
caps and truncation evidence. It enumerates approved/current identity and content references,
version/history identifiers, package IDs/hashes/status, and normalized module/evidence references;
it excludes raw content, private support notes, guest conversations, source locators, assets, and
secrets. Preview creates no artifact and performs no export, storage, revocation, or deletion.

## External credentials

The credential console is a dark, read-only inventory of disabled credential metadata. It may show
tenant/client/optional venue scope, capabilities, prefix, expiry, revocation, and last-used evidence.
PathFinder stores only a strong hash and non-secret prefix; no operator should expect plaintext
recovery. No issue, verify, enable, rotate, revoke, listener, or transport-auth lifecycle is live in
this foundation, even when rotation or revocation audit records are visible.

## Quarantined intake files

The client intake page may show private document/image submissions. `AWAITING REVIEW` confirms only
the exact private upload transport identity. It does not confirm that the file was parsed,
malware-scanned, safe to open, approved, applied, or published. The operator view deliberately has
no preview or download control.

If verification is temporarily unavailable, retry the unchanged file/claim. If the row is rejected,
ask the client to select the file again with a new request. Do not obtain the private object key or
open storage directly. Escalate any request to preview, download, retain, or delete raw bytes until
the owner approves the required privacy, retention, malware, and access policy.
