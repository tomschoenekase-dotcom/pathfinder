# Engagement-question domain actions

Engagement-question create, update, and delete commands use the neutral actions in
`packages/db/src/helpers/engagement-question-actions.ts`. The tenant tRPC router remains the
authenticated adapter and requires `MANAGER` access before it supplies the signed-in human actor.

The action boundary independently enforces `HUMAN` `OWNER|MANAGER` attribution, exact tenant scope,
bounded normalized prompts and choices, update/delete revision compare-and-swap, and a strict
sanitized platform audit in the same transaction. Audit evidence records type, intensity, active
state, and choice count; it does not copy prompt or option text.

Create currently has no durable request key. An ambiguous client retry can therefore create a
second question. Update and delete are revision-fenced but are not replay protocols. These actions
must not be advertised as agent-grade idempotent commands until a durable command identity is
justified. Local unit and tenant-boundary tests cover call shape and scope; no external database or
disposable-database rollback test was run for this slice.
