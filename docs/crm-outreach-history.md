# CRM outreach history and cold-outreach eligibility

The directory and account page show cold-email count, last cold email, first human
reply position, relationship, next eligible date, eligibility reason, and contact
health separately. Opportunity owner and next action retain their existing owners.
The directory offers never contacted, first/final follow-up due, conversation,
deferred, stopped, and history-review views.

## Evidence and preservation

There is no schema migration. The existing canonical email-message unique key
(`providerAccountId`, `providerMessageId`) deduplicates mailbox observations. The
existing append-only activity evidence and unique receipt key store versioned,
source-bound classification/review records. Activity totals and opportunity stage
never determine cold-email count. Existing send items/outbox, observed messages,
and delivery events retain their separate meanings. Sent does not prove delivery.

Count only classified cold messages with observed send evidence. Warm replies do
not increment the cold sequence. Automated replies, out-of-office messages and
delivery notices do not establish human engagement. Missing classification,
mailbox coverage, or unresolved identity produces Unknown, never an assumed zero.
Canonical merges and explicitly reviewed parent scope aggregate contacts and
mailboxes. Similar names or shared domains alone never establish parent identity.

History reviews bind the message set, contacts, mailbox coverage, and provenance.
New messages or changed identity invalidate that review. Address failure evidence
is bound to the affected recipient; an account decline is a relationship decision,
not an automatic unsubscribe. Provider policy refusal does not establish an
invalid address. Old notes and all previous reviews remain retained.

## Rules

The first cold follow-up requires exactly one prior cold email, no human reply,
and 21 elapsed days. The final cold email requires exactly two prior cold emails,
no human reply, and one calendar month since the second. Month-end dates clamp to
the last day of the following month while retaining UTC time. Three unanswered
cold emails exhaust the sequence.

Conversation, decline, deferral, customer/closed relationship, unsafe contact,
policy hold, unresolved identity, incomplete history, and another unsent draft
prevent cold outreach. Candidate selection, draft creation/review, batch approval,
release, and worker revalidation use shared history checks. Existing human approval
and verification requirements remain. A warm draft requires a source-bound human
reply anchor; a caller cannot bypass cold rules by relabeling a draft.

## Staging cohort procedure

Use the bounded cohort CLI in dry-run mode first. Its input is private, reviewed
mailbox metadata and exact staging identity mappings, never an activity-count
export. Keep receipts outside the public repository. Apply only to the pinned
staging resource, with all delivery/provider workers disabled. A disconnected
observation mailbox stores provenance without credentials or send permission.
Rerun the same input and compare receipt identities, message counts and original
record hashes. Do not expand beyond the representative cohort until it passes.

Uncertain records remain Unknown. A company-mailbox-only search cannot certify
coverage of personal or historical mailboxes. Fictional test cases establish rule
behavior; they do not establish real customer correspondence or delivery.
The initial release delivers the framework and bounded import path. Completing
historical account coverage can be delegated separately; unknown records stay held
until that evidence is reviewed.

## Production rollout requires separate approval

1. Review the final staging commit, test results, rendered CRM, sample receipts,
   retained unknowns, and exact environment admission.
2. Resolve the real-cohort coverage gaps and confirm recipient/address mappings.
   Review any additional historical mailbox through its authorized connection.
3. Take the existing release-path backup/preservation evidence. Schema is unchanged;
   verify the migration chain and original records are unchanged at the final SHA.
4. Approve a production release through the existing staging-to-master promotion
   gate. Keep outbound delivery disabled during initial evidence reconciliation.
5. Apply the reviewed small cohort, rerun it to prove idempotence, and inspect all
   seven views. Expand in bounded batches only after sample acceptance.
6. Enabling or sending outreach is a separate human action. Roll back application
   code if needed; retain append-only evidence and receipts rather than deleting
   history or resetting counts.


## MCP read, write, edit and remove parity

The staging catalog adds `crm.get_outreach_history`, `crm.propose_outreach_history_review`, `crm.propose_outreach_history_retract` and `crm.propose_record_update`. The read returns canonical eligibility, message metadata, current revision/record IDs and ready-to-copy mutation arguments. Evidence and messages are separately paginated; default windows are 25 and max 100. No body is returned by the history plan. Review binds source hashes server-side; receipt plus effective projection comes back after writing. MCP-generated evidence is attributed to the authenticated operator agent, not a fictitious human reviewer. Complete reviews require actual per-mailbox full-search provenance. Scope/parent identity remains a human-owned decision.

Existing account/contact tools cover create, field updates, address correction, archive and restoration. Existing follow-up/stage tools retain owner/next-action responsibility. The new generic record tool covers editable draft revision/discard, campaign edit/archive/restore, safe campaign member removal, and append-only note correction/archive/restore. Full note reads expose current revision and original words; archived notes can be explicitly included. A queued/ambiguous draft or member with send intent is refused rather than silently cancelled. A campaign restore never reactivates delivery. Draft HTML and frozen provenance are not arbitrary edit fields; actual outgoing approvals, send intent and provider receipts remain immutable.

History removal is a source-bound soft retraction, not deletion of provider messages, actual sends, consent, approvals or audit receipts. Correction/retraction cannot make an unreviewed chronology appear as zero sends or clear suppression; uncertainty holds outreach. Contact policy health and cold cadence remain separate from address readiness; `crm.check_can_contact` now exposes both. A valid email address alone never clears a history hold.

Use one returned operation UUID for an unchanged retry. Changed content needs a new operation UUID; stale revision needs a fresh read. Deploying the staging catalog does not change installed production tools; production changes require a separate reviewed production deployment. These additions grant no new sending, mailbox or production authority.
