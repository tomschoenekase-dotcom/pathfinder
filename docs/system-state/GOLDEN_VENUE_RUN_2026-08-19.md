# Golden Venue run report — 2026-08-19

Fixture: `golden-venue-riverside-aquarium-v1` (synthetic)

| Evidence                               | Status                       | Notes                                                                                                                                                                  |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture contract                       | VERIFIED                     | Validator covers all 13 declared phases, seven failure classes, and the explicit disposable-proof scope.                                                               |
| Disposable core lifecycle              | VERIFIED                     | `pnpm golden-venue:disposable` passed on 2026-08-22 with one executed/non-skipped 20-step integration.                                                                 |
| Disposable isolation and cleanup       | VERIFIED                     | Fresh digest-pinned PostgreSQL/Redis/MinIO/ClamAV used exact loopback; all exact containers were removed.                                                              |
| Client → release/rollback              | VERIFIED                     | Client/venue, intake, upload evidence, review, support handoff, package, QA, release, and rollback passed.                                                             |
| Grounded guest chat and feedback       | VERIFIED_PROVIDER_DARK       | Real public routers, retrieval, gateway routing, complete turn/history, ownership-bound feedback, and analytics passed with deterministic in-process provider clients. |
| Report and routine update              | VERIFIED                     | Opt-in report publication/client read and tenant-published time-bounded update passed.                                                                                 |
| Offboarding/export                     | PARTIAL                      | Human review, four versioned bounded artifacts, exact replay, and `EXPORT_READY` passed; no revocation, deletion, cancellation, delivery, or retention policy.         |
| Full 13-phase lifecycle                | PARTIAL                      | All required phases have disposable evidence; offboarding/support remain deliberately partial and live-provider quality is unproved.                                   |
| Provider-backed chat/evaluation/report | UNVERIFIED_PROVIDER_DISABLED | Credential-bearing providers were stripped and outbound/provider workers remained disabled.                                                                            |
| Failure injection                      | VERIFIED                     | All seven declared classes passed in the same retained disposable flow with exact cleanup.                                                                             |

Machine-readable terminal evidence:

```json
{
  "action": "golden-venue.core-lifecycle.disposable-shakedown.passed",
  "testsPassed": 1,
  "services": ["postgresql", "redis", "minio", "clamav"],
  "outboundProviderWorkersEnabled": false,
  "proofScope": [
    "client",
    "venue",
    "onboarding",
    "upload-intake",
    "review",
    "content-package-eval",
    "release-rollback",
    "guest-chat-grounded-provider-dark",
    "visitor-feedback-persisted",
    "support-handoff",
    "report-publish-read",
    "routine-update-publish-read",
    "offboarding-reviewed-export-ready"
  ],
  "failureScope": [
    "provider-outage",
    "rate-limit",
    "bad-upload",
    "duplicate-request",
    "failed-worker",
    "report-failure",
    "ambiguous-provider-outcome"
  ],
  "cleanup": "verified-absent"
}
```

This report is intentionally truthful: the provider-dark core now includes the public guest-chat and
visitor-feedback boundaries. Deterministic provider clients prove routing, retrieval, persistence,
ownership, and analytics—not live-provider answer quality. The seven-class provider-dark failure
matrix is retained and green. Reviewed non-deleting export finalization and recovery are now proved
in disposable infrastructure. Consequential revocation, cancellation, deletion, delivery, and
retention policy remain unproved.
