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

For Venue Deployment Manifest v2, use the internal manifest review to validate the hash, warnings and
exact conversion into `venuePackage.preview` / `venuePackage.createDraft` inputs. The review screen
does not persist or execute anything. Treat base-hash and semantic compatibility warnings as review
work, not permission to bypass the existing package lifecycle.

Guest previews may include callouts, actions, citations, choices, images, galleries, events, and
locations as well as legacy text and place cards. Reject unknown block types. Image and map links
must be HTTPS and must not contain credential- or secret-like parameters. A safely rendered block
is still only a preview; it does not prove that a remote asset is approved, durable, or live.

## Rollback

Use versioned package or content-history rollback controls. Confirm the target version, venue, actor,
and resulting version. Do not perform direct database rollback. An ambiguous result requires a fresh
authoritative read before retry.

## Support

Client-visible messages and internal notes are separate visibility classes. Never copy private or
internal evidence into the client thread. A support request may result in a package patch, but the
patch still follows validation, evaluation, preview, approval, and apply boundaries.

The verified package-lineage action can attach an exact support request version to an existing
same-client, same-venue `DRAFT` package. Confirm both scopes, request version and target package
before linking. The link is append-only and auditable; it neither changes package status nor marks
the support request complete. Status-transition controls expose only allowed next states. Transitions
require the displayed request
version/current status and may conflict if another operator acted first; reload before retrying.
`VALIDATING` includes validation/evaluation review in the current persisted vocabulary. Moving a
request to `APPLYING` or `COMPLETED` records workflow state only and never executes a package.

Use support triage to assign a category and a concise missing-information checklist before changing
workflow state. Triage requires the displayed request version, retains selections on a conflict,
and records one audited revision. It does not message the client, change status, create a package,
or apply content; communicate deliberately through the separate message composer.

Package approval, apply, and revert require an owner, the displayed package revision, exact reviewed
evidence, and a unique command key. A repeated matching command is a replay; a command key already
used by another package is a conflict. Existing V1/V2/V3 rollback behavior remains distinct—do not
assume the richer V3 lineage rules apply to legacy packages.

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

## Universal content and MCP reads

Generalized Service, Policy, Event, Operational Fact, and Relationship modules are independently
versioned. Create, revise, and retire only through the default-off typed workbench; every operation
is exact-scope, audited, and previewed as unpublished even when its audience is `PUBLIC`.

MCP v0 has concrete bounded read bindings for its 12 resource types. They use verified scope,
resource-bound cursors, explicit safe selects, and output leakage filtering. There is still no MCP
listener, credential issuance/verification, OAuth, or live authentication path; do not describe the
bindings as an externally reachable service.

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
