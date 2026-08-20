# Production Readiness Implementation — 2026-08-19

Packet: `CODEX_PACKET_01_PRODUCTION_READINESS.md`

## Baseline and preservation

- Branch at start and handoff: `codex/torchiko-cloud-staging-20260819`.
- HEAD at start and handoff: `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b`.
- The repository already contained a large uncommitted capability/migration tranche. Its status was recorded before work. No pre-existing changes were discarded, reset, committed, staged, or rewritten as a separate claim of authorship.
- No production or remote staging data was accessed or changed. No live provider call or operational alert was sent.

## Changes made

### Migration and capability stabilization

- Audited the ordered capability migrations `20260819140000` through `20260819155000` and extended the tranche with `20260819156000_add_operational_event_delivery_audit`.
- Registered the new delivery-attempt model in tenant isolation and updated the raw-SQL, tenant-bypass, admin-procedure, and public-surface boundaries affected by the tranche.
- Verified the complete migration lineage from an empty disposable PostgreSQL database. All 123 migrations applied successfully. The exact synthetic database was then dropped and verified absent.
- Also applied the new forward migration to the existing local disposable staging database. No remote migration command ran.

### Guest failure contract

- Added stable public guest error codes for provider unavailability, rate limiting, ambiguous outcomes, unavailable content, rejected input, and retry-safe transient failures.
- The production tRPC formatter exposes only the sanitized public code and message. Provider names, prompts, keys, stack details, and internal errors remain private.
- The guest client now reconciles ambiguous operation IDs, permits only safe same-operation retries, and avoids automatic retry loops for known unavailable/rejected/content failures.
- Important provider and pre-dispatch failures create best-effort sanitized operational evidence.

### Readiness and operations health

- Kept `/api/health` as the existing bounded DB/Redis liveness endpoint.
- Added the platform-admin-only `admin.operationsReadiness` query with bounded DB/Redis probes and persisted evidence for migration parity, worker heartbeat/mode, scheduler state, BullMQ queue depth/age/failures, recent job outcomes, object/malware evidence, AI outcomes, embedding outcomes, email outcomes, and stuck running jobs.
- Added a persisted worker heartbeat in both provider-enabled and provider-disabled modes.
- Added queue inspection across the major BullMQ queues with a 1.5-second API-side bound.
- Operational interpretation and limitations are in `docs/operations-readiness.md`.

### Operational-event delivery

- Added an append-only `OperationalEventDeliveryAttempt` audit relation and composite tenant ownership constraint.
- Added bounded outbox materialization, event/channel/destination deduplication, severity routing, persisted exponential retry, six-attempt suppression, and sanitized failure evidence.
- Added an adapter boundary open to email, Slack, and webhook channels. The first concrete adapter is Resend operator email.
- Destination identity stored with a delivery is an opaque SHA-256 key; the recipient is not persisted in the delivery record.
- Delivery is dark by default. The development log sink is forbidden in production, and the email adapter requires an explicit enable flag, recipient, and provider key.
- Configuration and activation controls are documented in `docs/operational-event-delivery.md`.

### Golden Venue harness

- Added `scripts/golden-venue/fixture.json`, its validator, and `pnpm golden-venue:validate`.
- The synthetic Riverside Aquarium fixture defines stable identifiers, all 13 lifecycle phases, three expected guest questions/answers, evidence locations, and seven failure injections.
- Seed/reset and evidence procedures are in `docs/golden-venue-runbook.md`.
- The current truthful run report is `docs/system-state/GOLDEN_VENUE_RUN_2026-08-19.md`. Static fixture and safety validation passed; provider-backed and remote-staging phases remain explicitly unverified rather than simulated.

### Privacy and retention preparation

- Added a working `/privacy` route with an explicit “Approved policy pending” status notice. It is deliberately not presented as a privacy policy.
- Added route tests and verified the route in the production build and local smoke.
- Enumerated the founder decisions needed before retention execution and added bounded manual export/deletion guidance in `docs/privacy-retention-activation.md`.
- No retention executor or legal language was invented or enabled.

## Verification evidence

| Check                                 | Result                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                      | PASS — 23/23 tasks                                                                                                      |
| `pnpm lint`                           | PASS — 13/13 tasks; one existing `PlaceCard.tsx` raw-image warning, no errors                                           |
| `pnpm test` package suites            | PASS — 3,926 tests; 139 environment-dependent integration tests skipped by their existing guards                        |
| `pnpm test:scripts`                   | PASS — 164 passed, 1 intentional legacy-data skip                                                                       |
| `pnpm build`                          | PASS — 13/13 tasks; web, dashboard, and workers built; `/privacy` emitted                                               |
| `pnpm test:accessibility`             | PASS — 7 axe contract tests                                                                                             |
| `pnpm test:browser-foundation`        | PASS — 189 DOM/browser-foundation tests                                                                                 |
| `pnpm test:redis:disposable`          | PASS — recovery, dispatch, terminal-redrive, and media-admission suites each 2/2; container removed and verified absent |
| Disposable PostgreSQL migration       | PASS — all 123 migrations from empty database; database removed afterward                                               |
| AI provider boundary                  | PASS — 1 documented temporary worker exception remains                                                                  |
| AI budget boundary                    | PASS — 16 gateway sites                                                                                                 |
| Raw SQL boundary                      | PASS — 95 registered operations                                                                                         |
| Tenant bypass boundary                | PASS — 198 calls in 67 approved files                                                                                   |
| Tenant procedure coverage             | PASS — 98 tenant procedures                                                                                             |
| Tenant registry                       | PASS — 125 models: 114 tenanted, 9 platform, 2 shared                                                                   |
| Public surfaces                       | PASS — 15 tRPC, 7 HTTP modules, 2 dashboard paths                                                                       |
| Client bundle secrets                 | PASS — 11 canaries across 413 deliverable files                                                                         |
| Docker/staging/character static gates | PASS                                                                                                                    |
| Golden Venue validator                | PASS — 13 phases, 7 failure injections                                                                                  |
| Safe local smoke                      | PASS — PostgreSQL, Redis, MinIO, and ClamAV healthy; worker provider-disabled; `/api/health` 200; `/privacy` 200        |

The production build retains the existing OpenTelemetry/Sentry dynamic-require warning and Windows standalone-link-name warning. Both builds completed successfully. The strict remote staging health/widget verifiers correctly refused without the required authorized HTTPS target, release revision, resource identities, and widget admissions; no unsafe substitute was used.

## Commit and release boundary

The working tree was already dirty, and several packet edits necessarily overlap the existing schema, API, worker, and guest files. Do not create a blind whole-tree commit.

Recommended review boundary:

1. Review and commit the pre-existing capability tranche through migration `20260819155000`, including its UI/API/model/registry changes.
2. Hunk-review the packet additions: public guest errors, readiness query/heartbeat/queue snapshot, operational delivery processor and migration `20260819156000`, privacy route, Golden Venue harness, and the four new operational/privacy documents.
3. Re-run the migration, tenant, raw-SQL, public-surface, client-bundle, build, and test gates on the exact release commit.
4. Deploy that reviewed commit to staging only through the existing confirmed staging workflow. Production remains out of scope.

## Remaining external blockers and exact Tom actions

These are intentionally not completed because they require authority or decisions outside this packet:

1. Provide counsel-approved privacy text and the effective date/contact/controller details listed in `docs/privacy-retention-activation.md`; replace the pending notice only after approval.
2. Decide and approve every retention duration, legal-hold rule, backup/PITR behavior, deletion SLA, processor behavior, and evidence owner in that document before enabling automated deletion.
3. Authorize an exact remote staging release/target and run the Golden Venue lifecycle using `docs/golden-venue-runbook.md`. Record real evidence in a new dated run report. Do not mark provider phases verified while providers are disabled.
4. For a live Golden Venue provider smoke, approve the provider configuration and spend ceiling separately. Verify outage, timeout, and retry behavior as well as successful answers.
5. To activate operator alerts, approve a recipient and provider account, set the explicit delivery flag and recipient/key variables, then first observe a controlled staging event. Leave the development sink disabled in production.
6. Run the strict HTTPS staging health/widget admission commands with the deployed immutable revision and confirmed resource/widget identities. Their refusal without these values is expected safety behavior.
7. Review the dirty-tree commit split above before staging or committing; the implementation did not claim or co-mingle the earlier tranche in an automatic commit.

## Newly discovered P0/P1 issues

- P0: none found.
- P1: no new code defect found. The release remains operationally blocked on a real authorized staging Golden Venue run, approved privacy/retention policy, and deployment-specific provider/alert configuration. These are external readiness gaps, not simulated successes.
