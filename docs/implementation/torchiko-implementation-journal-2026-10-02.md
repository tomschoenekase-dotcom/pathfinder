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

## Routines (2026-10-02)

- A23: routines now check tenant suspension, customer churn, venue offboarding, request closure or client reply, reminder count and end date before materializing a run. A stop disables and audits the routine. A period budget reserves a per-run estimate atomically and refuses a run as `BUDGET_EXCEEDED` before creating effects. The budget ledger has a database overspend check; a mid-period currency change cannot reinterpret prior spend. The worker records a JobRecord. Migration `20261002112000_add_routine_stop_rules_and_budgets` is additive.
- Tenant-scoped routine proposals refuse `PROSPECT_CONTACT` stop subjects before any global CRM read: the platform prospect table has no proven tenant relation. A previously stored subject of that kind stops safely as `SUBJECT_MISSING`. Forbidden-path unit and database tests cover this. Integration follow-up: A06/A12 email replies are recorded in `clientInboundReply`, so the support-request stop rule must check that table after both lanes merge; this lane currently checks portal `supportMessage` replies.
- Database checks used local `pathfinder_disposable_einstein_routines` on `127.0.0.1:35432` and Redis index 5; all provider keys were dummy CI values. Logs stayed in the lane root outside the repository. No hosted migration, provider request, send or money action ran.
- `pnpm install` — PASS. `PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS=1 pnpm db:migrate:disposable -- --database pathfinder_disposable_einstein_routines --confirm-database pathfinder_disposable_einstein_routines` with `PATHFINDER_DISPOSABLE_DATABASE_URL` set to that local database — PASS, 260 migrations present and none pending.
- `pnpm typecheck --concurrency=2` — PASS, 27/27 tasks. `pnpm lint --concurrency=2` — PASS, 15/15 tasks.
- `pnpm exec vitest run src/helpers/agent-routine-guards.test.ts src/helpers/agent-routine-actions.test.ts --pool=forks --maxWorkers=1` from `packages/db` — PASS, 34/34. `pnpm exec vitest run src/operator/kinds/reports-routines.test.ts --pool=forks --maxWorkers=1` from `packages/api` — PASS, 31/31.
- `RUN_AGENT_ROUTINE_GUARDS_DB_INTEGRATION=1 pnpm exec vitest run src/helpers/agent-routine-guards.disposable.integration.test.ts --pool=forks --maxWorkers=1` from `packages/db` — PASS, 24/24 after updating legacy global-contact expectations. `RUN_OPERATOR_DB_INTEGRATION=1 pnpm exec vitest run src/operator/kinds/reports-routines.disposable.integration.test.ts --pool=forks --maxWorkers=1` from `packages/api` — PASS, 4/4.
- `pnpm test` with dummy CI env — FAIL, one real new tenant-registry expected-list omission in the DB package; fixed. `pnpm exec vitest run src/middleware/tenant-isolation.test.ts --pool=forks --maxWorkers=1` — PASS, 347/347. `pnpm test` from `packages/db` — PASS, 321 files/2319 tests; 63 files/161 tests intentionally skipped without DB flags. Final integrated full `pnpm test` remains the merger's gate.
- `pnpm test:scripts` — FAIL, 620 tests: 600 PASS, 19 FAIL, 1 skipped. Four Windows CI YAML CRLF parser failures and one stale current-truth migration count require integration updates. Fourteen are the known staging migration-admission pins. The pin script and its tests were not edited.
