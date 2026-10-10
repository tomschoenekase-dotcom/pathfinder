# Guide context fidelity code-only release — October 10, 2026

> **Migration instruction status: RESTRICTED PRODUCTION EXCEPTION — LIVE GATES REQUIRED.**

Tom directly authorized this candidate's release through staging and production on October 10,
2026: “I authorize it. Do whatever you need to do.” The approval covered read-only inventory,
live guide verification, and application rollback if needed.
The reviewed application candidate is `483e6ac9f5d30d9076b17149bd38014f60e9d9eb`, with
tree `c3b40b11dea1b7922d0756e65eb522ecaed1608e`, seven commits above production base
`bfd0a8e427e44dce46219084e8ab5fefc728fdfe`. The schema and migration paths have no diff
against that base. This record changes documentation and the documentation safety test only;
the final documentation-bearing SHA must retain the reviewed application files unchanged.

This is a code-only application release. No hosted database migration, data repair, seed, reset,
restore, or deletion is approved. A new schema difference or pending migration stops this
exception. Backup, restoration, and migration rehearsal gates for a database change are not
invoked for this code-only transition; production data and the migration ledger stay preserved.
The production incident remains ACTIVE by default, and all earlier exceptions remain historical.

Require green exact-head CI on the final documentation-bearing SHA, then fast-forward only the
dedicated staging branch to that SHA. Require green staging CI, successful web, dashboard, and
worker deployments at that exact SHA, and the trusted three-service admission with healthy
staging resources. Check production's pending venue packages read-only before promotion; report
the risk that prior validation evidence may be refused by the new code. Do not apply or delete a
package as part of this release.

Promote only that admitted staging SHA through the protected production promotion gate. Require
production CI and read back the exact revision from production health. Watch health for at least
15 minutes and ask real visitor questions across two venues, excluding Lost Island. Report each
answer failure with the question and answer. Preserve existing worker and provider flags, and do
not send email or change customer data.

The previously admitted application SHA is `bfd0a8e427e44dce46219084e8ab5fefc728fdfe`.
Before promotion, verify that its three production deployments remain eligible for application
rollback. If production health fails or visitor answers regress, use the provider's recorded
deployment rollback for web, dashboard, and workers as needed, and verify health and revision
afterward. Never attempt to reverse a database migration or fast-forward Git backward.
