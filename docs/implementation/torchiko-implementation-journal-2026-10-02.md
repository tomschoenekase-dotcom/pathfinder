# Torchiko implementation journal — packet r001 (2026-10-02)

Branch `claude/exciting-einstein-bl59qp`, based on `origin/master` `26a9e7e` (same tree as deployed production
`9f726af`) plus the operator-program journal commits `c58bf0a`, `08276b1`. Environment: cloud container, no hosted
database, no Stripe/Clerk/Gmail send credentials, Chromium only (no Playwright WebKit), no physical device.
Result vocabulary: PASS / FAIL / NOT RUN / BLOCKED. "Implemented" never means "verified on a provider/device".

## Baseline and safety (G0)

- Repo instructions read (CLAUDE.md; no AGENTS.md). Incident boundary `docs/database-incident-stop.md` read: production
  incident ACTIVE by default; no hosted DB access used in this run.
- Operator production release `9f726af` with migration 255: recorded complete in
  `torchiko-operator-checkpoints.md` (2026-10-01 entries, three-service acceptance PASS). This satisfies the W13
  prerequisite; CI changes were made only afterwards.
- Environment issues: `cdn.sheetjs.com` blocked by network policy (local-only substitute `xlsx@0.18.5`, never
  committed); GitHub push 403 (Claude GitHub App/access missing) — all commits local; git bundle sent to the owner.
- Local baseline before changes: `apps/web` vitest 70 files / 534 tests, 1 failure needing `pnpm characters:sync`
  (environmental), then green.

## Workstream log

| Lane                  | Commit(s)            | Outcome                                                                             |
| --------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| W01 mobile chat       | `8e9c6b6`, `f3e75c7` | One viewport model; send dismisses keyboard; single-line hint; device protocol      |
| W02 cursors           | `c2c3a22`            | Query-bound opaque cursors on every operator list; honest `complete`                |
| W02 operator page     | `4470a6e`, `5809015` | Root cause: server page used a value from a `'use client'` module; per-panel errors |
| W02/W06 look-and-feel | `dca1ae1`            | Same defect class on the client portal page; repo-wide boundary test                |
| W02 unknown create    | `6d18ea2`            | Pre-persistence failures reported as not-recorded; provider reconciliation by op id |
| W06 notices (A15)     | `51129cd`            | Shared lifecycle; isActive never means live; idempotent end                         |
| W09 billing           | `36f5337`, `b3e4ad8` | Explicit 14-state model; webhook tenant-mismatch, ordering, grace, fixture guards   |
| W13 CI                | `c5155e6`            | Fail-safe dependency-aware plan; master flake fixed; always-resolving gate          |
| W15 business prep     | `f3e75c7`            | CityPASS drafts (unsent), NYC research plan                                         |
| Docs safety           | `c86d1ac`            | Required historical/incident markers                                                |

Later lanes (W03, W04, W05, W07/W11, W08, W10) are recorded in the final handoff.

## Key findings with evidence

1. **Visitor blank band (IMG_0341).** `useChatViewportHeight` (55c3bb6) "verified" the pinned shell with
   `getBoundingClientRect`; iOS WebKit reports fixed-element rects in visual-viewport coordinates, so the pan was
   added twice. Removed the measurement loop; the shell follows `visualViewport` directly. Details and references in
   `torchiko-keyboard-device-protocol.md`.
2. **Clipped hint (IMG_0342).** WebKit wraps a textarea placeholder; replaced with a composer-drawn single-line hint.
3. **`/admin/operator` outage.** Commit 3917966 (2026-10-01) made `OperatorAdminView` a client module while the server
   page still called `OPERATOR_TABS.find(...)` on it → throws on every server render. `/look-and-feel` dotted into
   `BRANDING_REVIEW_SUBJECTS` from a client module (same class). Both fixed; test fails on the old shapes.
   Production log confirmation: NOT RUN (needs log access).
4. **Unknown customer create `36b36c4b-…`.** Caller-supplied operation ids; failures before the proposal insert were
   labelled `outcome: unknown` → `get_operation` NOT_FOUND. Now `NOT_RECORDED` (no effect, safe resend); real
   unknowns reconcile via Clerk metadata. Production reconciliation: BLOCKED (owner-approved read-only checks in
   `unknown-customer-create-reconciliation.md`).
5. **Billing blank page.** Panel returned `null` when disabled; every error collapsed to "not available". Now explicit
   states with retry; config/retrieval failure is never shown as no subscription.
6. **Master CI red on release merge.** Flaky `VenuePackageLifecycleControls` retry test (fenced click); test waits for
   re-enable. Operator branch also failed docs-safety test (missing markers) — fixed.

## Acceptance status (this run)

See the final handoff for the complete A01–A29 / M / B / L / CI / H / P / S table.

## Dbint (2026-10-02)

- Finished the six inherited DB test edits and current API/worker fixtures. Two approved forward-only migrations now make JavaScript capability ordering locale-independent in the evidence trigger and admit `CLIENT_REPORTED` voice usage without reclassifying it as provider-observed. Updated the readiness endpoint to the actual latest migration. No hosted migration, send, provider call, or staging-admission pin edit occurred.
- Design: preserve every credential allowlist and operation/activation/revocation evidence gate; keep client-reported voice usage distinct from observed billing. The migration contract tests compare the credential trigger body and constrain the voice guard replacement. Local test resources were own loopback PostgreSQL/Redis/MinIO/ClamAV with synthetic credentials only.
- Evidence root `$B = C:\Users\tomsc\MachineWorkspaces\torchiko\20261002-einstein-dbint`; exhaustive per-file final status, initial fail/skip, classification, and log are in `$B\logs\integration-suite-summary.tsv` (170/170 baseline integration files PASS). Five additional lane feature DB files and the direct Redis script are covered by integration lanes/root, giving 176 final tracked files.
- `pnpm install --frozen-lockfile` — PASS (`$B\logs\pnpm-install.log`).
- `& 'C:\Program Files\Git\bin\bash.exe' /c/Users/tomsc/MachineWorkspaces/torchiko/20261002-einstein-dbint/batch-integration.sh packages/db db-batch-all` and same script with `packages/api api-batch-all`, `apps/workers workers-batch-all-rerun`, `packages/jobs jobs-batch-all`, `packages/billing billing-batch-all`, `apps/dashboard dashboard-batch-all` — initial FAIL/SKIP from shared DB state, exact-name guards, and missing local services; original logs `$B\logs\*-batch-all.log`. Every initially failing/skipped file was rerun serially with an isolated database or service and is PASS in the TSV; no guarded skip is counted as proof.
- `& 'C:\Program Files\Git\bin\bash.exe' /c/Users/tomsc/MachineWorkspaces/torchiko/20261002-einstein-dbint/run-named-cases.sh packages/db /c/Users/tomsc/MachineWorkspaces/torchiko/20261002-einstein-dbint/logs/named-packages-db.cases named-db` and same script for `packages/api` with `named-packages-api.cases named-api` — initial FAIL on credential locale sort, stale truncate/contract/timing fixtures, and missing disposition roles; corrected and fresh reruns PASS. Exact file commands and logs are in `$B\run-named-cases.sh`, `$B\logs\named-*-summary.tsv`, and TSV.
- `pnpm --filter @pathfinder/db typecheck`, `pnpm --filter @pathfinder/api typecheck`, `pnpm --filter @pathfinder/workers typecheck` — PASS (`$B\logs\typecheck-{db,api,workers}.log`).
- `pnpm --filter @pathfinder/db lint`, `pnpm --filter @pathfinder/workers lint` — PASS. `pnpm --filter @pathfinder/api lint` — FAIL on another lane's unused import in `operator-company-reports-billing.disposable.integration.test.ts`; integrator fixed it separately and reports full lint PASS. Logs `$B\logs\lint-{db,api,workers}.log`.
- `node --test scripts/disposable-redis-integration.test.mjs` — PASS 13/13 (`$B\logs\script-disposable-redis.log`). `RUN_VENUE_PACKAGE_DUPLICATE_MIGRATION_INTEGRATION=1 PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS=1 PATHFINDER_DISPOSABLE_DATABASE=pathfinder_disposable_dbint_legacy_migration PATHFINDER_DISPOSABLE_DATABASE_URL=postgresql://postgres:<synthetic>@127.0.0.1:35432/pathfinder_disposable_dbint_legacy_migration node --test scripts/venue-package-duplicate-analysis-migration.integration.test.mjs` — PASS (`$B\logs\script-venue-package-legacy-migration.log`).
- `node --test scripts/operations-readiness-migration.test.mjs` — FAIL: frozen 255-migration endpoint assertion conflicts with the approved forward migrations; pin left unchanged (`$B\logs\operations-readiness-migration-contract.log`). This is among the 14 known admission-pin failures to report, not a runtime readiness failure; guarded readiness suite PASS (`$B\logs\worker-readiness-local-updated.log`).
- Full lane `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:scripts` — NOT RUN as duplicate global work; integrator is running them on the merged exact head. Scoped unit suite — NOT RUN in lane; integrator reports full unit PASS. The full DB suite proof here includes all 170 baseline files, both mutually exclusive disposition modes, and both bridge-runner cases.
- Remaining decisions: venue timezone migration and doc-name replacement await Tom. Release/rollback remains an integrator proposal only; no deploy or rollback executed.
