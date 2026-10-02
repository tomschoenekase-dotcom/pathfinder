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

## Offboard (2026-10-02)

A24 now has an off-by-default `offboarding.propose_execution` kind and additive migration
`20261002113000_add_offboarding_execution`. A reviewed plan covering every customer venue can be
proposed; a human platform approver must apply it. The executor records step receipts, stops at the
first failure, resumes settled steps idempotently, and records billing and identity-provider work for
a person. It closes public venues, stops scheduled work, revokes only the connection categories the
plan selected, marks customer and local membership rows inactive, and writes a data manifest. It
never calls live providers or deletes data. Reinstatement restores public venues and local membership
rows while listing credentials, schedules, billing, and identity-provider access as manual work.

Review repairs: a CONNECTIONS step previously revoked all three categories when only one was
selected; the runner now restricts each mutation to its selected target. Shared operator grant
narrowing now uses an exact-array compare-and-set with reread/retry so simultaneous customer
offboardings cannot restore each other's scope. A failed first step with no settled receipt now
resolves as UNKNOWN because it may have partially changed data. Before a resumed plan is marked
complete, the executor verifies the selected local effects still hold; a reopened venue, for
example, leaves the execution in progress with a partial-application error. Choosing either guest
links or widgets closes the shared venue availability, including guest chat, QR, and embeds; the
preview discloses this coupled effect. Local SUSPENDED/REMOVED fields are
not an app-wide access gate: Clerk organization sessions and some app reads remain reachable until
a person removes identity-provider access. This is an explicit release limitation, not a claim of
completed access revocation.

Checks (local disposable `pathfinder_disposable_einstein_offboard`, Redis DB 6):

- PASS — `pnpm install` (lockfile unchanged).
- PASS — `pnpm exec vitest run src/operator/kinds/offboarding-execution.disposable.integration.test.ts --pool=forks --maxWorkers=1` from `packages/api`, with local DB env and `RUN_OPERATOR_DB_INTEGRATION=1` (15 tests; first attempt failed three new fixtures because their synthetic secret prefixes exceeded the schema length, corrected and rerun).
- PASS — `pnpm exec vitest run src/helpers/offboarding-execution-policy.test.ts src/helpers/offboarding-execution-migration-contract.test.ts --pool=forks --maxWorkers=1` from `packages/db` (27 tests).
- PASS — `pnpm verify:raw-sql` (262 operations) after registering the tenant/plan advisory lock and removing a computed method call.
- PASS — `pnpm typecheck --concurrency=2` (27/27); `pnpm --dir packages/api exec tsc --noEmit` after the final drift guard.
- PASS — `pnpm --dir packages/db test` (322 files, 2324 tests; 62 files and 137 tests skipped).
- PASS — `pnpm --dir packages/api test` (310 files, 3341 tests; 86 files and 325 tests skipped). The first run found stale embedded manual text; the corrected rerun passed.
- FAIL — `pnpm lint --concurrency=2` on a pre-existing unused `OperatorNotFoundError` import in `packages/api/src/operator/kinds/operator-company-reports-billing.disposable.integration.test.ts`; the outreach lane removes it on integration.
- PASS — focused `pnpm exec eslint --config packages/config/eslint/base.js` over the new offboarding API/DB files and embedded manual text.
- FAIL — `pnpm test:scripts` (599 PASS, 20 FAIL): 14 known frozen staging migration-admission pins plus four CI job inventory assertions and two current-truth/security inventory assertions on this isolated lane. The integration lane owns the changed inventory/current-truth assertions; the staging pins remain intentionally untouched.
