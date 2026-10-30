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
