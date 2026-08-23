# Golden Venue run report — 2026-08-19

Fixture: `golden-venue-riverside-aquarium-v1` (synthetic)

| Evidence                               | Status                       | Notes                                                                                                      |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Fixture contract                       | VERIFIED                     | Validator covers all 13 declared phases, seven failure classes, and the explicit disposable-proof scope.   |
| Disposable core lifecycle              | VERIFIED                     | `pnpm golden-venue:disposable` passed on 2026-08-22 with one executed/non-skipped 18-step integration.     |
| Disposable isolation and cleanup       | VERIFIED                     | Fresh digest-pinned PostgreSQL/Redis/MinIO/ClamAV used exact loopback; all exact containers were removed.  |
| Client → release/rollback              | VERIFIED                     | Client/venue, intake, upload evidence, review, support handoff, package, QA, release, and rollback passed. |
| Report and routine update              | VERIFIED                     | Opt-in report publication/client read and tenant-published time-bounded update passed.                     |
| Offboarding/export                     | PARTIAL                      | Requested draft and metadata-only preview passed; no revocation, deletion, cancellation, or finalization.  |
| Full 13-phase lifecycle                | PARTIAL                      | Provider-backed guest chat and visitor feedback remain unproven end to end.                                |
| Provider-backed chat/evaluation/report | UNVERIFIED_PROVIDER_DISABLED | Credential-bearing providers were stripped and outbound/provider workers remained disabled.                |
| Failure injection                      | PARTIAL                      | Exact rollback/replay/cleanup passed; the seven-class failure matrix has not yet run as one retained flow. |

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
    "support-handoff",
    "report-publish-read",
    "routine-update-publish-read",
    "offboarding-draft-export-preview"
  ],
  "cleanup": "verified-absent"
}
```

This report is intentionally truthful: the provider-dark core is now operationally proved, while the
remaining guest-chat/visitor-feedback phases, consequential offboarding execution, provider-backed
quality, and the complete failure matrix are not.
