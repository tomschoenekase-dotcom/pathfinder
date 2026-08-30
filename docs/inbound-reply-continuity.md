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
