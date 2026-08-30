# Prospect follow-up review

The platform-admin Outreach Center includes a bounded, read-only view of active prospect follow-up
records. It is derived from durable schedules, their approval evidence, and current opportunity,
campaign, and correspondence state.

The view distinguishes due and future schedules, ready-for-draft records, and held records. It
caps evidence at 100 active follow-ups and discloses when more records exist. A due record is only a
review signal; it is not permission to draft, schedule, send, or contact another person.

The projection explicitly preserves the founder boundaries:

- automatic scheduling is not authorized;
- automatic sending is not authorized;
- alternate-contact outreach is not authorized;
- exact follow-up cadence remains unresolved;
- existing reply, suppression, contactability, approval, and delivery controls remain canonical.

This implementation performs no provider call, message creation, delivery, schedule mutation,
customer contact, pricing decision, or production action.
