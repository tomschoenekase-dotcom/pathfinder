# Progressive agent approval policy

Torchiko separates an agent's capability from the operating policy that determines whether one
use needs a fresh human approval. Six executable policy-backed action classes are intentionally
narrow: `pathfinder.create_update_draft` with `updates:draft` authority and
`pathfinder.create_support_draft` with `support:draft` authority, and
`pathfinder.open_support_request` with `support:open` authority, and
`pathfinder.add_support_internal_note` with `support:note` authority, and
`pathfinder.create_intake_notes_proposal` with `intake:draft` authority, and
`pathfinder.generate_weekly_report_draft` with `reports:draft` authority.

A platform administrator can enable this policy from the venue Agent workspace for one exact
tenant, venue, agent identity, action, and capability. Issuance requires a stable policy key, an
idempotent operation ID, a human reason, explicit title-or-subject/body bounds, and optional use and expiry
bounds. Every successful exercise creates an append-only `ApprovalGrantConsumption` with run,
worker, credential, parameter hash, and result lineage. Issuance and revocation are strictly
audited.

New policy-backed grants must also cite between one and twenty-five immutable
`AgentOutcomeObservation` records for that exact tenant, venue, and agent identity. Torchiko
stores their exact membership in `ApprovalGrantEvidence` and shows it with the policy in the
Founder Control Room. This is authority-decision provenance, not a score or an automatic
recommendation: positive, mixed, negative, and inconclusive observations remain available for the
human administrator to interpret. Existing legacy policies remain readable and are labeled when
they predate structured authority evidence.

The operational-update evaluator accepts only a schema-valid informational `GENERAL_NOTICE` draft with
`INFO` severity and `NORMAL` priority inside the reviewed content bounds. It verifies the exact
tenant and venue and requires expiry after start. Unknown constraint versions, action classes, or
capabilities fail closed. A rejected attempt does not increment use count.

The support-draft evaluator accepts only one of the established support categories within the reviewed
subject/body bounds. The canonical write creates a `DRAFT` request with one `INTERNAL_ONLY`
message, no customer requester, no participant, and no customer activity/version marker for the
message.

The separate support-open evaluator accepts only exact client/venue scope, an existing request and
version, and the literal `DRAFT` to `OPEN` transition. The Founder Control Room always issues this
policy with `maxUses: 1`. The canonical status action records full machine/grant lineage without
adding a participant or message, changing client activity, contacting a customer, executing work,
or permitting any later transition. Human operators retain cancellation and all later states.

The separate support-note evaluator accepts only exact client/venue scope, an existing request and
version, `INTERNAL_ONLY` visibility, an empty attachment list, and a body inside the reviewed bound.
The Founder Control Room always issues this policy with `maxUses: 1`. The canonical message action
records full machine/grant lineage while leaving client version/activity, participants, request
status, triage, and package lifecycle unchanged. Customer-visible replies remain human-only except
for the exact founder-approved information-request and completion paths described below.

Support triage uses the exact-parameter approval path rather than a reusable policy. The proposal
freezes request ID/version, category, and the normalized missing-information list. One founder
decision records approval and atomically issues a one-shot grant for those exact parameters while
performing no triage itself. `pathfinder.apply_support_triage` then consumes that grant and uses the
canonical CAS-protected triage action. It increments the support request and client versions once,
but cannot change status, add participants, send messages, contact the customer, execute a package,
or authorize later work. Replays return the recorded result and parameter drift fails closed.

Client information requests also use exact-parameter approval rather than reusable policy. The
proposal freezes request ID/version/current status, the existing normalized triage checklist, and
the full in-app prompt while changing no request, message, or client-activity state. A founder
decision atomically issues one one-shot grant but performs no contact. Only
`pathfinder.apply_support_information_request` can consume that exact grant: it reuses the canonical
CAS-protected support action to create one client-visible in-app message, increment request and
client versions once, and move the request to `WAITING_FOR_CLIENT`. It cannot send email, change
participants or triage, execute package work, or authorize later contact. Exact replays do not
duplicate the message; parameter or version drift fails closed.

Support completion uses the same exact-parameter separation. The proposal freezes request
ID/version/current status, the full client-visible completion message, and an exact digest of every
linked package handoff and its applied identity. It fails closed unless the missing-information
checklist is empty and every linked package is fully `APPLIED`; requests with no package handoff
remain valid. A founder decision atomically issues one one-shot grant without contacting the client
or changing lifecycle state. Only
`pathfinder.apply_support_completion` can consume that exact grant: it reuses the canonical
CAS-protected action, rechecks the exact package evidence in the same transaction, creates one
in-app completion message, increments request and client versions once, and moves the request to
`COMPLETED`. Manual completion shares the all-linked-packages-applied guard. It cannot send email,
add participants, alter triage, execute package work, or authorize later contact. Exact replays do
not duplicate the message; parameter, package, or request-version drift fails closed.

Support-linked package authoring is a distinct DRAFT-only exact-parameter path. The proposal
freezes the complete V3 payload, its derived operation breakdown, request ID/version/status,
immutable draft key, evidence, and payload digest while creating no package, handoff, message, or
support change. A founder decision atomically issues a one-shot `packages:draft` grant but executes
nothing. Only `pathfinder.apply_support_package_draft` can consume that exact grant. It calls the
canonical package-draft service and, in the same transaction as draft persistence, links the DRAFT
to the unchanged support request with full agent/run/worker/credential/grant lineage. Exact replay
returns the committed DRAFT and handoff without duplication; parameter drift fails closed. This
authority cannot approve, apply, publish, or roll back the package, message the client, change
request status or triage, increment client activity, or trigger external delivery. Those later
package lifecycle transitions remain separately gated.

Support-linked package approval uses its own `packages:approve` capability and exact proposal.
`pathfinder.propose_support_package_approval` freezes the unchanged `DRAFT` timestamp, payload/base
identity, warning digest/codes, immutable support handoff, and up to 20 exact-package evaluation run
IDs. Evaluation is advisory and the snapshot explicitly records that no threshold was applied. The
proposal changes nothing. A founder `APPROVED` decision issues one exact one-shot grant, but still
executes nothing. Only `pathfinder.apply_support_package_approval` may consume that grant. It calls
the canonical package approval action with the human decision-maker retained as `approvedBy` while
recording the executing agent/run/worker/credential/grant lineage separately. Exact replay
converges; package, handoff, parameter, or decision drift fails closed. This authority cannot apply,
publish, revert, contact a customer, or change the support request.

Support-linked package application is a third, explicitly consequential boundary. The
`packages:apply` proposal freezes one exact unchanged `APPROVED` package, its human approval
evidence, immutable support handoff, warning identity, and bounded evaluation references. The
proposal and founder decision mutate nothing. The founder surface states that later execution
changes current venue content and may be visitor-visible immediately. An `APPROVED` decision
issues one exact one-shot grant; only `pathfinder.apply_support_package_application` may consume
it. Execution reuses the canonical application lifecycle and attributes `appliedBy`, audit, run,
worker, credential, grant, model, and idempotency lineage to the verified agent. Exact replay
converges and parameter drift fails closed. The grant includes no support completion, customer
contact, external delivery, or revert authority; each remains separate.

Support-linked package reversion is a fourth, recovery-only boundary. The
`packages:revert` proposal freezes one exact unchanged `APPLIED` package, its rollback-manifest
digest, immutable handoff, and the current version/status of an active `OPEN` or `IN_REVIEW`
support request. Completed requests are rejected so fulfillment history is not silently
invalidated. Founder approval issues one exact one-shot grant and executes nothing. Only
`pathfinder.apply_support_package_reversion` may consume it, and execution delegates to the
canonical rollback lifecycle, which independently refuses unsafe content drift. Replay converges;
package, manifest, request, handoff, parameter, or decision drift fails closed. This grant creates
no automatic rollback policy and includes no support-state change, customer contact, or external
delivery authority.

The intake evaluator accepts only `NOTES` within the reviewed character bound and exact client and
venue scope. The canonical write creates an `AWAITING_REVIEW` intake run with complete machine
lineage. It performs no extraction, package creation/application, publication, or customer contact.

The weekly-report evaluator accepts only an exact client and venue, a reviewed title bound, and a
date range no longer than the reviewed maximum. The canonical action is shared with the human admin
API, respects venue/global AI admission and report configuration, and creates or replays one durable
internal generation request. It may consume configured AI budget. It cannot edit, publish, deliver,
or make a report client-visible; those remain separate human-only transitions.

Reusable policy does not authorize publication, scheduling, customer contact, billing, access
changes, or any action outside the venue. Exact one-shot approval is required for the bounded
in-app information request or completion described above. The existing exact-parameter approval path remains
available. No policy is created by a migration, fixture, startup routine, or agent; a human platform
administrator must enable it explicitly and can revoke it from the same mobile-responsive surface.

Disposable proof is available through:

```text
pnpm test:agent-approval-policy:disposable
pnpm test:support-completion:disposable
pnpm test:support-package-draft:disposable
```

The shakedown uses random disposable infrastructure, verifies one-shot compatibility, exact
outcome membership, policy issuance replay, bounded policy consumption for all six registered
action classes, fail-closed parameter rejection, private support visibility, approval-bound one-use
opening and internal note, durable evidence, and cleanup. It performs no provider call,
publication, customer contact, or real billing action.
