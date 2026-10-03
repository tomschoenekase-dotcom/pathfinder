# Inbound reply continuity

When Gmail synchronization matches an inbound message to one canonical prospect thread, Torchiko
updates the durable CRM relationship state atomically:

- append one `REPLY_RECEIVED` activity with message/thread matching evidence;
- move the exact campaign member from `QUEUED` or `SENT` to `REPLIED`;
- hold the matched pending follow-ups through the existing inbound-sync flow;
- update the opportunity's last-activity timestamp; and
- advance only `CONTACTED` or `FOLLOW_UP_DUE` opportunities to `REPLIED`, with append-only stage
  history and strict system audit evidence.

The transition does not classify sentiment or claim that the reply is positive. It never regresses
`REPLIED`, `CONVERSATION`, `QUALIFIED`, or later stages, and it never revives `WON`, `LOST`,
`PARKED`, or `DO_NOT_CONTACT`. Missing opportunities do not cause the canonical message/activity to
be discarded and are preserved as auditable organization-level evidence.

This slice adds no reply generation, send authority, follow-up scheduling, alternate-contact
outreach, provider authentication, or customer contact.

## Human-reviewed reply disposition

The prospect correspondence view now lets a human platform administrator classify an exact
canonical inbound message as `POSITIVE_INTEREST`, `QUESTION_OR_OBJECTION`, `NOT_INTERESTED`,
`SUPPRESSION_REQUEST`, or `OTHER`, with a required reason. Torchiko never derives that disposition
from the compact body preview.

Every review is append-only, actor-bound, operation-idempotent, and revisioned. The email message
holds a database-validated pointer to the current review, so later corrections do not leave two
equal pieces of current truth. A positive-interest review updates the existing founder-attention
event title and context for that exact message; other dispositions receive equally explicit copy.
The review itself does not send email, suppress a contact, change opportunity stage, or authorize a
follow-up. Those remain separate governed actions.

## Client notification replies

An email reply to a client notification (an information request sent by the client-notification
worker) is linked to its support request without ever guessing a tenant:

- Each queued notification email is claimed with a freshly minted RFC `Message-ID`
  (`<ci.<random>@<sending domain>>`) that is stored on the intent and sent as the `Message-ID` header.
- A reply is matched only by strong identifiers: that id in `In-Reply-To`/`References`, the
  `Message-ID` of a reply that was already linked (a chain), or the provider thread of a linked reply.
  Subject and sender are never used to find a thread.
- Once identifiers fix one request, the sender must be the exact recipient the notification went to.
  Otherwise the message is quarantined (`SENDER_MISMATCH`).
- Tenant, venue and request come from the matched outbound record only. Identifiers that point at
  more than one request are quarantined (`AMBIGUOUS_THREAD`); no identifier match is `UNKNOWN_THREAD`;
  oversized, truncated or malformed messages are quarantined without storing any content.
- Quarantine rows (`client_inbound_quarantines`) have no tenant and hold identifiers, hashes and sizes
  only. Linked replies (`client_inbound_replies`) hold a bounded preview of the new text, a body hash
  and a sender hash; the full message stays in the mailbox.
- A linked reply moves a `WAITING_FOR_CLIENT` request to `IN_REVIEW` through the existing transition
  graph (audit event `INBOUND_EMAIL_REPLY_LINKED`). It creates no support message, answers no question,
  and completes nothing. Any other status is left unchanged.
- Delivery is idempotent on provider + mailbox + provider message id. Operators read linked replies
  with `support.list_replies`.

`createInboundCorrespondenceService` accepts an optional `clientReplyLinker`, offered only inbound
messages that no prospect thread claimed. The Gmail sync worker passes one; it sends nothing.
