# Exact operator-question deduplication

An agent can retry the same question using a new operation ID. Previously this produced another founder question even when the active run, evidence, and requested decision were unchanged. The question helper now retains each operation as a durable alias to one canonical pending question.

Consolidation requires the same tenant, venue, agent identity, and non-null run, plus identical normalized question text, context, type, category, urgency, ordered choices, due time, expiry, evidence, proposed answer, callback metadata, and blocking behavior. JSON object key order does not distinguish questions; array order does. Answered, dismissed, or expired questions and questions without a run are independent.

The existing run lock serializes canonical question creation. A tenant-scoped operation lock and unique operation ledger preserve idempotency when calls race. Replaying either operation returns its canonical question, including a later recorded answer. Reusing an operation with changed content conflicts. Consolidating records an audit event without adding another question message or repeating the run's blocking transition. Questions and answers remain descriptive data; consolidation grants no action or publication authority.

The migration backfills every original question operation and uses foreign keys containing tenant and venue scope. Database triggers reject alias updates, deletion, and truncation; the application also treats the ledger as append-only. Existing question records, answers, discussion history, and original operation IDs remain intact. Supported callers receive a `consolidated` result alongside the existing `replayed` result.

This handles exact duplicates within one workflow. Semantic similarity, cross-run question grouping, shared answers across distinct evidence, and automatic authorization remain separate concerns. Deployment and production migration require the existing explicit release and backup gates.
