# Support request package handoffs

`SupportPackageHandoff` is immutable lineage between an exact tenant-and-venue-scoped support request version and an already-existing `DRAFT` venue package.

Only a human platform support operator can create a link. The canonical domain action rejects closed requests, stale request versions, cross-scope records, non-draft packages, duplicate links, and client actors. The request version increment, relation insert, support audit event, and strict global audit record share one transaction.

The action never creates a package and never approves, applies, reverts, publishes, or otherwise changes package lifecycle state. The Internal Support UI deliberately exposes only an existing-draft selector and historical lineage. The migration is forward-only and must be reviewed and applied through the normal database release process; it is not applied by this implementation.

## Support status transitions

Support status changes use a separate human-operator-only domain action with exact scope, request-version CAS, an append-only `STATUS_CHANGED` support event, and strict platform audit in the same transaction. The graph is deliberately closed: received requests may wait for client information or enter review; review may return for information or record a package draft; package drafts move through validation, approval waiting, applying, and completion. Cancellation is allowed before applying. Terminal requests cannot reopen.

`VALIDATING` is the existing enum's closest lifecycle stage for validation and evaluation review; no separate evaluation status exists. This limitation is shown in the operator UI rather than expanding the database enum. Status changes are evidence labels only: they do not validate, evaluate, approve, apply, publish, or otherwise mutate a venue package. Client APIs continue to expose status as read-only data and provide no transition procedure.
