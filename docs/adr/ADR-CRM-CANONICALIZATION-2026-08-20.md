# CRM canonicalization and prospect correspondence

- Status: accepted
- Date: 2026-08-20
- Scope: Torchiko prospect CRM and prospect correspondence

## Decision

PostgreSQL/Torchiko is the sole writable operational system of record for prospects, locations, contacts, opportunities, campaigns, drafts, approvals, frozen send batches, correspondence, suppression, conversions, and material agent or human actions.

The PathFinder SQLite Outreach ledger is a migration source and then a read-only legacy archive. Original SQLite identifiers and source provenance are retained in PostgreSQL. There is no bidirectional synchronization.

Gmail/Google Workspace is the initial provider for individually addressed, human-approved prospect correspondence. Resend remains available only to separate transactional or demonstrably opted-in customer communication paths. CRM prospect code must use the `CorrespondenceProvider` boundary and must never make Resend the cold-outreach default.

`ProspectOpportunity` is the canonical owner of pipeline stage, owner, priority, next action, next-action due date, and won/lost/parked reasoning. Organization and location records own identity, fit, territory, provenance, tags, and archive state; compatibility fields are read-only projections during their removal window.

Customer conversion has two levels: an organization-level customer relationship links one prospect organization to a Torchiko tenant, while child location links connect individual prospect locations to live venues. The original prospect graph and history remain intact.

Provider credentials are referenced through the encrypted external-secret boundary. OAuth secrets and refresh tokens are never stored in ordinary CRM rows. Provider and mailbox/account namespace every external identifier.

Agents operate only through a verified server-side Agent Run context. They may read, research, annotate, draft, and recommend. They cannot approve, release, send, convert, merge, delete, restore contactability, alter credentials, or enable delivery.

Prospect delivery is fail-closed and dark by default. Approval and final release are separate human actions. Final release writes immutable operations to a transactional outbox; workers claim those operations with leases and reconcile ambiguous provider outcomes before retrying.

Calendar, Meet, Drive, autonomous outreach, and attachment downloads are explicitly deferred.

## Consequences

- Existing Resend-shaped prospect webhook/worker code is retired from the prospect runtime, not reused as the Gmail implementation.
- Push notifications are hints. Gmail history synchronization and scheduled reconciliation are authoritative recovery paths.
- External websites, workbooks, and email are untrusted evidence, never instructions or authorization.
- Mutable current-state projections remain separate from append-only relationship, suppression, provider-event, and audit history.
- Operator configuration and a separately authorized internal-recipient smoke test are required before any real send.
