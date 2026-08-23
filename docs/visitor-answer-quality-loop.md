# Visitor answer quality loop

Torchiko records deterministic low-confidence and knowledge-gap insights after a public guest turn
when the answer lacks sufficiently strong trusted retrieval evidence. An explicit visitor
`NOT_HELPFUL` rating also records one idempotent `VISITOR_NEGATIVE_FEEDBACK` insight for the exact
turn. No model judges that signal and no severity is inferred. The guest response remains available
immediately; post-response retrieval intelligence is best effort and cannot fail the chat turn.

The durable feedback insight preserves historical evidence. The review projection additionally
checks the assistant message's current rating, so a visitor changing the rating to `HELPFUL` removes
the negative-feedback item from the active queue without deleting history.

## Governed machine workflow

An externally authenticated worker needs two distinct, database-admitted capabilities:

- `conversations:review` calls `torchiko.knowledge.list_gaps`. It returns at most 25 already-flagged
  public turns with the bounded visitor question, assistant answer, insight classification, and
  exact message IDs. It returns no visitor identity, coordinates, arbitrary session replay, or
  unflagged conversations.
- `knowledge:draft` calls `torchiko.knowledge.propose_correction`. The server re-loads the exact
  insight and both messages, verifies an online credential-bound worker and a live scoped agent run,
  derives evidence IDs instead of trusting tool arguments, and creates one idempotent
  `PENDING_REVIEW` proposal.

The proposal separates the visitor observation, AI inference, proposed correction, reason,
confidence, target entry when applicable, and source conversation. A database partial unique index
prevents concurrent active proposals for one insight. Rejected proposals may be replaced.

## Authority boundary

Preparing a correction marks the insight `ACTIONED`, appends machine-attributed audit lineage, and
opens a Founder Control Room review event. It does not edit, enable, disable, retire, re-embed, or
publish venue knowledge. Human approval also remains evidence-only; publication is a distinct
audited workflow.

No provider execution is required for the loop itself. A capable model may reason over the bounded
evidence and existing authorized knowledge tools, while deterministic fixtures can prove the full
policy and persistence path provider-dark.
