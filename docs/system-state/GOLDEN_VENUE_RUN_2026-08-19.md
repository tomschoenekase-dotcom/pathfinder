# Golden Venue run report — 2026-08-19

Fixture: `golden-venue-riverside-aquarium-v1` (synthetic)

| Evidence                               | Status                       | Notes                                                                                                      |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Fixture contract                       | VERIFIED                     | Validator covers all 13 declared phases, seven failure classes, and the explicit disposable-proof scope.   |
| Disposable core lifecycle              | VERIFIED                     | `pnpm golden-venue:disposable` passed on 2026-08-22 with one executed/non-skipped 15-step integration.     |
| Disposable isolation and cleanup       | VERIFIED                     | Fresh digest-pinned PostgreSQL/Redis/MinIO/ClamAV used exact loopback; all exact containers were removed.  |
| Client → release/rollback              | VERIFIED                     | Client/venue, intake, upload evidence, review, support handoff, package, QA, release, and rollback passed. |
| Full 13-phase lifecycle                | PARTIAL                      | Guest chat, visitor feedback, report, routine update, and offboarding/export remain unproven end to end.   |
| Provider-backed chat/evaluation/report | UNVERIFIED_PROVIDER_DISABLED | Credential-bearing providers were stripped and outbound/provider workers remained disabled.                |
| Failure injection                      | PARTIAL                      | Exact rollback/replay/cleanup passed; the seven-class failure matrix has not yet run as one retained flow. |

Machine-readable terminal evidence:

```json
{
  "action": "golden-venue.core-lifecycle.disposable-shakedown.passed",
  "testsPassed": 1,
  "services": ["postgresql", "redis", "minio", "clamav"],
  "outboundProviderWorkersEnabled": false,
  "cleanup": "verified-absent"
}
```

This report is intentionally truthful: the provider-dark core is now operationally proved, while the
remaining five lifecycle phases, provider-backed quality, and the complete failure matrix are not.
