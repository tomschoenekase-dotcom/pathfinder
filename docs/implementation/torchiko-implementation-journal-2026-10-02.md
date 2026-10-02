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

## W12 authenticated chat approvals and bounded job grants (2026-10-02)

### Design (written from the existing operator code)

Existing: `approveAndApplyProposal` / `rejectProposal` (packages/api/src/operator/proposals.ts) are called only by
`POST /api/operator/approve`, behind `guardOperatorMutation` (Clerk session, PLATFORM_ADMIN + operator allowlist,
exact-origin check, strict reverification). The approval POST is bound to the proposal `argsHash`; apply re-checks the
preview digest and target version. The MCP connection (bearer token) only reaches `createProposal`/reads/controls via
`registry.callTool`. Autonomy (`OperatorAutonomyPolicy`) is per-capability and owner-set; proposals carry
`autoApproved`.

A25 chat approvals (new `decisions.ts`, table `operator_decision_requests`):

- Chat side, `operator.request_decision {proposalId}` (control tool, `operator:plan`): own pending standalone proposals
  only (other grant / out-of-grant tenant = NOT_FOUND, plan step = refused). Records a ticket snapshotting argsHash,
  previewDigest and targetVersion, TTL 10 minutes, and returns a link. Repeating the call renders the decision. It
  never approves, rejects or applies.
- Human side, `decideRequest` is called only by `POST /api/operator/decide` after the same guard as approve. Order:
  allowlist, ticket exists, status/expiry, input argsHash equals ticket, proposal still PENDING with the same
  argsHash/previewDigest/targetVersion (else ticket INVALIDATED), then ONE compare-and-set REQUESTED->DECIDED (single
  use), then the existing approve/reject service. Replay, race and stale page all fail before touching the proposal.
- CSRF/replay: Clerk session + exact Origin + strict reverification + single-use ticket + argsHash body binding.
- Audit: `decision.request` events REQUESTED / DECIDED:approve|reject / EXPIRED / INVALIDATED, plus the existing
  proposal.transition rows. No operator tool imports `decideRequest` (static test).
- Plans: not covered (plans keep the approval page). Reuse, not fork: decisions call the existing services.

A26 bounded job grants (new `job-grants.ts`, table `operator_job_grants`, column `operator_proposals.job_grant_id`):

- Grant = name, operator connection (OAuth client), one tenant (+ optional venue), exact kinds, maxExecutions (1..100),
  optional maxAmountCents (only for kinds that declare `jobGrant.amountCents`), required expiry (default 24 h, 5 min..7 d),
  revocable. Counters are stored as REMAINING budget so a use is one conditional UPDATE (no overspend under races).
- Created/revoked only by `POST /api/operator/job-grants` behind the same human guard; no operator tool reaches it.
  An audit of the first implementation found that `createProposal` also _spent_ matching grants during MCP calls.
  That path was removed. The grant creator must use **Apply with my job grant** on the pending proposal's approval
  page; the guarded `apply` action matches kind/tenant/venue/connection server-side and binds the shown args hash.
- Default deny: a kind must set `jobGrant` itself; always-ask kinds and locked capabilities are refused. Only
  `appearance.update` opts in this lane; mail, invites, billing and all always-ask kinds stay non-grantable.
- Use: an authenticated creator explicitly spends one use to approve and apply the pending proposal, with
  `job_grant_id` recorded and audit outcome `JOB_GRANT_APPROVED` (args: jobGrantId). Revoked before apply = FAILED
  `JOB_GRANT_REVOKED`. Exhausted/expired/revoked/other scope/other kind = refusal; proposal stays PENDING.
- This lane does not provide scheduled autonomous use. The job grant is a bounded human-triggered option; MCP
  connections cannot mint, spend, or consume one.
- A claimed use is spent even if the change later goes stale or fails (conservative).
- Migration `20261002110000_add_operator_decisions_and_job_grants` (additive; both tables PLATFORM*TABLES; CHECK
  constraints on bounds). Disposable DB must be named `pathfinder_disposable*_`for the suites to run (not`pathfinder*einstein*_`), so this lane used `pathfinder_disposable_einstein_w12`.

### W12 verification (local disposable services, Redis DB 2)

- PASS — `pnpm install` (lockfile unchanged).
- PASS — `pnpm typecheck --concurrency=2` after the security refactor (27/27 tasks). An earlier uncapped run was interrupted during the database package build because concurrent lane Turbo runs exhausted host memory.
- PASS — from `packages/api`, with `RUN_OPERATOR_DB_INTEGRATION=1`, `DATABASE_URL` and `DIRECT_DATABASE_URL` set to local `pathfinder_disposable_einstein_w12`, and `REDIS_URL=redis://127.0.0.1:36379/2`: `npx vitest run src/operator/operator-authority.disposable.integration.test.ts src/operator/operator-execution.disposable.integration.test.ts src/operator/operator-oauth.disposable.integration.test.ts src/operator/operator-decisions-grants.disposable.integration.test.ts --pool=forks --maxWorkers=1` (4 files, 60 tests).
- PASS — from `packages/api`, `pnpm exec vitest run src/operator/operator-decisions-grants.test.ts --pool=forks --maxWorkers=1` (45 tests). An earlier combined command with `operator.adversarial.test.ts` skipped that file's 26 DB cases because the DB flag was absent.
- PASS — from `packages/api`, `pnpm exec vitest run src/operator/operator-decisions-grants.disposable.integration.test.ts --pool=forks --maxWorkers=1` with the local DB env and `RUN_OPERATOR_DB_INTEGRATION=1` after the security refactor (21 tests). The matching-grant case goes through `registry.callTool('appearance.propose_update', ...)` and proves the grant remains unspent until the signed-in route uses it.
- PASS — from `apps/dashboard`, `pnpm exec vitest run 'app/api/operator/operator-decision-grant-routes.test.ts' 'app/(admin)/admin/operator/page.test.tsx' --pool=forks --maxWorkers=1` (51 tests) and `pnpm exec vitest run components/operator/OperatorScreens.accessibility.test.tsx --pool=forks --maxWorkers=1` (24 tests; jsdom navigation diagnostics on an unrelated anchor).
- FAIL — `pnpm lint --concurrency=2` due to one pre-existing unused import in `operator-company-reports-billing.disposable.integration.test.ts`; focused ESLint on all changed TS/TSX files PASS. The parallel outreach lane fixes that import for integration.
- FAIL then PASS — `pnpm test` stopped in `packages/db` at two stale expectations for the new platform tables and new migration; both expectations were updated. `pnpm --dir packages/db test` then PASS (320 files, 2,293 tests; 62 files/137 DB cases skipped by design).
- FAIL — `pnpm test:scripts`: 14 expected staging migration-admission pin failures plus one tool-coverage count/digest mismatch caused by the new admin procedures. The integrator must refresh the tool-coverage inventory after all lanes merge; staging pins remain untouched.
- FAIL (invocation only) — root `npx vitest run packages/api/src/operator/operator-decisions-grants.disposable.integration.test.ts --pool=forks --maxWorkers=1` read the workspace file as a Vite config; repeating with `--config packages/api/vitest.config.ts` from root missed `packages/api/vitest.setup.ts`. The package-directory invocation above is the working command.
- NOT RUN — rendered browser check of the grant approval page (no provider-dark fixture for the guarded component); this is a release candidate verification item.
