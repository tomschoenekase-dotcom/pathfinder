# Public interest intake

Torchiko's public `/request-demo` flow replaces the former personal-email acquisition path with a durable, provider-dark intake boundary. It records an expression of interest for platform-admin review; it does not send email, create a CRM prospect, establish a price, create a customer account, begin onboarding, or start billing.

## Data and authority boundary

- `PublicInterestSubmission` retains immutable request evidence and the current review projection.
- `PublicInterestSubmissionReview` is append-only evidence for `MARK_REVIEWED`, `ARCHIVE`, and `REOPEN` decisions.
- The public mutation accepts a caller UUID and replays an identical request safely. Reuse with different content is rejected.
- Rate-limit keys hash normalized email and source address. The honeypot value and raw source address are not retained.
- Review remains a platform-admin operation. The agent-operation manifest deliberately does not expose contact-data review to operational workers.
- A submission is not canonical CRM truth. Any future CRM conversion or outbound communication needs a separately reviewed workflow and policy.

## Verification

The implementation includes public API validation/replay/rate-limit tests, admin authorization and review-history tests, responsive form and inbox component tests, a migration contract test, and a disposable PostgreSQL lifecycle proof. The disposable proof runs all migrations from zero, submits and replays an exact request, records an admin review, and proves database guards reject mutation of request evidence and review history.

Before staging, run the normal release verification and apply the complete migration chain. After deployment, smoke `/request-demo` with synthetic data, verify the item in `/admin/prospects/inbound`, exercise each review transition, and remove or archive the fixture. Do not use real prospect data until the deployment's privacy and retention handling has been reviewed.

## Recovery

The feature introduces additive tables and routes. A safe application rollback may leave the new tables unused. Do not drop the tables during routine rollback: preserve submissions and review evidence until an approved retention/deletion policy authorizes removal. If the public endpoint misbehaves, roll back the application or remove the marketing links while retaining stored evidence.
