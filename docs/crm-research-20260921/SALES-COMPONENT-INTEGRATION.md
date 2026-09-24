# CRM owner / pre-send component contract

Scope: September 21, 2026 local CRM acceptance. This is a concrete integration
contract, **not an installed adapter, another CRM, or sender activation**. No
schema migration or staging-package copy is needed for the accepted import.

## Actual owners and existing integration points

| Concern                        | Existing native owner                                                                                        | Future component consumption                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prospect identity              | `ProspectOrganization`, `ProspectVenue`, `ProspectImportSourceRecord`                                        | Resolve an exact organization/venue and original source locator, not a shared domain or pilot alias.                                                                                                                                          |
| Contact/route evidence         | `ProspectContact`, `ProspectSourceEvidence`                                                                  | Read exact route value, source association and UNKNOWN/readiness/permission states. A public listing is not consent or proof that a named person owns an inbox.                                                                               |
| Research provenance            | `ProspectSourceEvidence.capturedValue`, `sourceUrl`, `researchedAt`; immutable native import records         | A versioned evidence envelope may carry source bytes/record hash, hash scope, original observation time, claim category, allowed uses and exact source reference. Keep historical workbook observations distinct from later website research. |
| Bounded research execution     | `ProspectResearchJob`, `ProspectResearchAttempt`; `prospect-research-job-actions.ts`                         | Evaluate task-specific sufficiency before any authorized job is queued. Reuse native leases/attempt history; do not enqueue the entire imported workbook.                                                                                     |
| Relationship state             | `ProspectOpportunity`, `ProspectStageHistory`                                                                | A reducer returns a proposal. Only a separately authorized native transaction may apply a state change and its evidence. A prepared draft does not mean CONTACTED.                                                                            |
| Exact draft revision           | `ProspectOutreachDraft.version`, `groundingSnapshot`, `contentHash`; `prospect-outreach-actions.ts`          | Preserve preparation/source/language/WLT identities plus exact content and predecessor binding. Native review remains authoritative.                                                                                                          |
| Approval and frozen recipients | Existing draft approval and `ProspectSendBatch` / `ProspectSendItem` snapshot fields                         | Preserve the authenticated human decision over exact current content/recipient/context. Import completion, model meaning review and reusable-language approval are not email approval.                                                        |
| Correspondence metadata        | `CorrespondenceProviderAccount`, `ProspectEmailThreadProvider`, `ProspectEmailMessage`, `ProspectEmailEvent` | Gmail remains the future provider. Preserve opaque account/thread/message IDs and account-scoped uniqueness; never infer provider identity from subject text.                                                                                 |
| Reply review                   | `ProspectInboundReplyReview` and the message's current-review pointer                                        | Keep existing human disposition authority separate from an attributed model/reducer projection. A model must not impersonate a human reviewer.                                                                                                |
| Suppression                    | `ProspectContactSuppressionEvent` and native contact projections                                             | Collect all applicable contact/address/venue holds before preparation. Existing append-only evidence and native restoration controls remain authoritative.                                                                                    |
| Follow-up                      | `ProspectFollowup` and its existing helper                                                                   | A due date is not send authority. New inbound, stop/bounce, changed context or missing policy must hold/cancel as the native owner requires.                                                                                                  |

The repository already contains correspondence/provider and delivery infrastructure.
Its presence is not proof of a connected mailbox or authorized delivery. This task
did not configure, connect, invoke, extend or release that infrastructure.

## Required bounded handoff envelope

The future API owner should validate a versioned, read-only preparation input with:

```text
request_id, purpose, mode, as_of
organization_id, venue_id, contact_id (nullable), exact route kind/value
source_workbook_sha256, source external ID, sheet/row/raw-row hash
current CRM snapshot hash/version and explicit identity crosswalk
selected evidence IDs + original observed_at + source_ref + SHA-256 + hash_scope
evidence category, allowed uses, freshness limitation, missing/negative outcomes
all relevant suppression events and their scope; completeness declaration
for replies: provider account/thread/message IDs, latest inbound, reply target,
            exact bounded body/hash, complete snapshot ID/hash, live questions
SEND_AUTHORIZED: false
```

Resolve the pilot's `stable_identity` against source locators and actual CRM records.
Do not assume that its ID encoding equals the converter's `prospect-*` external ID
or native `porg_*` ID. Canonical converter identity is normalized venue name + city

- state; the existing native mapper additionally namespaces IDs by workbook hash.
  Identical-package replay is proven. Changed-workbook refresh requires an explicit
  crosswalk/link policy; it must not create duplicate prospects or replace curated
  state merely by calculating a new workbook-scoped ID.

The gate may return sufficient evidence, bounded research required, or a human/
source-contract hold. Newly captured evidence must enter an explicitly supported
CRM source catalog before the Composer treats it as a SOURCE FACT. The current
Composer only permits TASK CONSTRAINT and SALES HYPOTHESIS in caller-supplied
free text. Never disguise new venue facts as either category. Cache reads preserve
the original observation date; missing information stays unknown. An execution
adapter must enforce source/time caps, not merely trust reported usage.

## Draft persistence mismatches that must not be papered over

The existing native draft writer requires a campaign member and an email-ready
contact. The Composer can prepare review material with unresolved routes or UNKNOWN
contacts, and public-form routes are not email addresses. **Do not create a dummy
campaign, invent an email, or mark contacts VALID to force these artifacts through
that writer.** A future approved integration must either use an already authorized
native membership or introduce one narrowly reviewed non-campaign preparation/reply
identity seam. That decision and its migration/tests are deferred, not installed.

Hash namespaces also differ. The Composer hashes UTF-8 bytes of
`"Subject: " + subject + "\n\n" + body + "\n"`. The current native writer trims
subject/body and hashes `recipient + "\n" + subject + "\n" + textBody + "\n" + htmlBody`.
WLT's nested draft hash is body-only. Retain all labeled hashes; never substitute
one for another. Any native normalization must occur before the exact final review,
or force a new revision and fresh meaning/human review. Compare readback bytes with
the reviewed bytes. A generic JSON field alone does not authenticate an approval.

Store the external preparation ID/manifest hash, selected evidence snapshot,
Composer code/version, Approved Language entry/revision/approval-source hashes,
WLT packet identity, exact draft ID/revision/predecessor, and validation/meaning
review hashes with the native revision. Only genuinely approved language may be
selected; zero approved entries remains an explicit empty result. Source, route,
language, suppression or new-message changes invalidate an older preparation.

## Reply projection and transaction requirements

An eventual adapter supplies one complete, bounded provider/CRM snapshot to the
pure reducer. Retain the full snapshot hash, reducer version, latest-message IDs,
issues and proposed next action as a **derived** result. The present schema has no
dedicated reducer-current-version record: do not overload human reply-review
dispositions, overwrite message history, or start a second thread database.

The future native commit must lock/compare the exact current CRM/provider snapshot,
recheck suppression across threads, reject stale outputs, and append evidence before
advancing the authoritative pointer/state. Contacts reassociated to another venue,
referral candidates, contradictory identities, incomplete quoted bodies and missing
provider data hold for review. Empty suppression input cannot clear an existing stop.
Contact-scoped native suppression is not proof of complete organization/address-wide
coverage; any additional scope must be explicitly reconciled before delivery.

Only later, separately authorized human approval could bind recipient, exact subject/
body revision, provider account/thread/reply target, preparation/projection/suppression
snapshot and actual decision time. A future sender must recheck those bindings and
idempotency. An uncertain delivery outcome requires provider reconciliation, not a
blind retry. No sender/authentication work is authorized by this contract.

## Acceptance required for that later adapter

Exercise exact identity crosswalks (including shared domains and owner-only rows),
changed-workbook refresh, UNKNOWN contacts, form routes, negative/stale evidence,
new-fact catalog holds, both hash formats, Unicode annotation offsets (Python
codepoints versus JavaScript UTF-16), zero approved language, changed draft/recipient,
cross-thread suppression, new inbound during review, replay and concurrent/stale
commits. No adapter is accepted merely because the local component tests pass.

Read source contracts in AwesomeVault, not copied implementations:

- `95 AI Staging/Torchiko Outreach Composer 2026-09-20/INTEGRATION-CONTRACT.md`
- `95 AI Staging/Torchiko Correspondence Engine 2026-09-20/CRM-GMAIL-CONTRACT.md`
- `95 AI Staging/Torchiko Research Gate 2026-09-20/COMPOSER-INTEGRATION.md`

This contract deliberately leaves the operational owner singular and the accepted
source-only importer independent of all future email/reply activation.
