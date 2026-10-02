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

## Inbound (2026-10-02)

- A06/A12: inbound Gmail sync offers otherwise-unmatched inbound messages to a client-notification reply linker. A fresh outbound RFC Message-ID anchors matching; recipient equality is required after identifier resolution. Linked replies store a bounded untrusted preview and hashes, move only `WAITING_FOR_CLIENT` requests to `IN_REVIEW`, and are readable through `support.list_replies`. Unknown, ambiguous, mismatched, malformed and oversized messages remain quarantined. Migration `20261002111000_add_client_inbound_replies` is additive; no hosted migration or email was run.
- Scope: prospect-thread matching runs first. Client replies never become a support message, answer a question, complete work, or authorize another action. Follow-up for integration: the A23 support-request routine stop rule must also check `clientInboundReply` because inbound email replies do not create `supportMessage`.
- Environment for database checks: `DATABASE_URL` and `DIRECT_DATABASE_URL` pointed at local `pathfinder_disposable_einstein_inbound` on `127.0.0.1:35432`; Redis index 4; provider keys were dummy CI values. Logs stayed in the lane root outside the repository.
- `pnpm install` — PASS.
- `PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS=1 pnpm db:migrate:disposable -- --database pathfinder_disposable_einstein_inbound --confirm-database pathfinder_disposable_einstein_inbound` with `PATHFINDER_DISPOSABLE_DATABASE_URL` set to that local database — PASS, 260 migrations present, none pending. The first invocation without `PATHFINDER_DISPOSABLE_DATABASE_URL` was refused as designed.
- `pnpm typecheck --concurrency=2` — PASS, 27/27 tasks. An earlier unconstrained `pnpm typecheck` was interrupted during shared-machine memory contention and is NOT RUN to completion.
- `pnpm lint --concurrency=2` — PASS, 15/15 tasks after removing one pre-existing unused import in an API integration test. First run FAIL on that import.
- `pnpm test` with the packet's dummy CI env — FAIL, 26/27 Turbo tasks passed; dashboard had one Windows/local-date fixture failure. The first attempt without CI env also failed four worker suite startup checks for absent dummy Clerk values. `pnpm exec vitest run lib/server-client-boundary.test.ts components/billing/BillingStateView.test.tsx --pool=forks --maxWorkers=1` from `apps/dashboard` — PASS, 339/339 after portable path and local-noon fixture fixes. Final integrated `pnpm test` remains the merger's gate.
- `RUN_CLIENT_INBOUND_REPLY_DB_INTEGRATION=1 pnpm exec vitest run src/helpers/client-inbound-replies-disposable.integration.test.ts --pool=forks --maxWorkers=1` from `packages/db` — PASS, 7/7 including cross-tenant refusal and concurrent duplicate delivery.
- `pnpm test:scripts` — FAIL, 620 tests: 599 PASS, 20 FAIL, 1 skipped. Four CI YAML CRLF parser failures and two stale current-truth inventory counts require integration updates; the other 14 are the known staging migration-admission pins. The pin script and its tests were not edited. No live provider or hosted database checks were run.
- Follow-up safety fix: each RFC and provider-thread anchor lookup now reads one row past its 20-row bound and quarantines overflow as `AMBIGUOUS_THREAD`. This prevents a truncated result from hiding a different tenant or request. `pnpm exec tsc --noEmit -p tsconfig.json` from `packages/db` — PASS; `RUN_CLIENT_INBOUND_REPLY_DB_INTEGRATION=1 pnpm exec vitest run src/helpers/client-inbound-replies-disposable.integration.test.ts --pool=forks --maxWorkers=1` from `packages/db` against the same disposable DB — PASS, 8/8; `pnpm exec eslint --config ../config/eslint/base.js src/helpers/client-inbound-replies.ts src/helpers/client-inbound-replies-disposable.integration.test.ts` — PASS. An initial bare `pnpm exec eslint` invocation was NOT RUN because this package requires its explicit shared config; no lint findings were reported.
