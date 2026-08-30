# Public interest to prospect conversion

The public `/request-demo` intake remains provider-dark and stages immutable evidence in
`PublicInterestSubmission`. It does not automatically create CRM state.

A human platform administrator can explicitly promote an unarchived submission from the inbound
interest inbox. The mutation delegates to `convertPublicInterestToProspectAction`, which reuses the
same transactional prospect creation primitive as the ordinary administrator CRM flow. It creates:

- one prospect organization and opportunity at `DISCOVERED`;
- one prospect venue;
- one prospect contact with `REVIEW_REQUIRED` email readiness and permission state;
- one source-evidence record containing the immutable submission snapshot; and
- one append-only `PublicInterestProspectConversion` record linking the source to all three CRM
  identities.

The conversion, source evidence, review projection, strict audit entry, and canonical prospect
records commit atomically. `operationId` plus a canonical request hash makes exact retries safe,
including concurrent retries. Reusing an operation ID with changed intent fails closed. A submission
can be converted only once, and possible matches by normalized organization name, website domain,
or contact email are rejected for manual duplicate reconciliation.

Conversion does not send communication, grant outreach permission, set a price, create a customer
tenant or customer venue, start onboarding, create billing state, or invoke Stripe. Archived
submissions must be reopened before conversion. The conversion ledger is protected from update and
delete by database triggers.

Rollback before staging deployment is removal of the candidate migration and application changes.
After the migration has been applied, preserve the append-only evidence table and roll application
code forward; do not drop it to roll back a UI or API defect. Staging admission remains protected by
the exact frozen migration manifest and backup-evidence checks.
