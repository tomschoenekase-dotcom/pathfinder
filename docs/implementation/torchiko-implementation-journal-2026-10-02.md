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

## Outreach (2026-10-02)

Acceptance row A04 (grounded outreach draft): the context pack is now built.

**What changed.** New read-only operator tool `crm.get_outreach_context` (capability `crm:read`, scope `platform`,
like the other CRM reads). Input: `organizationId`, optional `contactId`, optional `venueId`. Output is a bounded,
deterministic pack (`outreach-context-v1`): account and venue facts, the chosen contact with its draft/release
eligibility and suppression ledger entry, correspondence counts plus up to 5 recent message previews and 3 prior
drafts, up to 5 recorded notes, up to 10 source-evidence items with public https URL, research date and freshness,
up to 5 legacy research URLs, a fixed list of claims marked supported/unsupported, per-section
`total/returned/cap/truncated`, `limits.complete`, `limits.truncatedSections` and a source fingerprint.
No model call, no Gmail/network access, no send, no write, no migration (read model over existing tables).

**Files.** `packages/contracts/src/operator-mcp.ts` (tool name, input, output, catalog seed);
`packages/api/src/operator/outreach-context.ts` (pure builder); `packages/api/src/operator/tools/crm-outreach-context.ts`
(loader + registration, exported `loadOutreachContext`); `tools/index.ts`; manual text and `docs/operator/manual.md`;
tests (unit, contract list, reads list, disposable integration).

**Design decisions.**

- Contactability reuses the shared rule (`eligibilityForContacts` -> `evaluateProspectContactEligibility`, purpose
  `draft`, including an address blocked on another record). Any draft reason makes `drafting.allowed=false`;
  not-verified for release is only a warning. A requested contact is never overridden; auto selection takes the first
  draftable live contact (venue match first, then id) from a bounded 30-contact scan and says when it was bounded.
- When drafting is not allowed the pack withholds notes, evidence, legacy sources and message text, and omits the
  address. Message text of a person who may not be contacted is withheld even when drafting to someone else is allowed.
- Free text is untrusted-marked and address-redacted; source URLs must be public https (no credentials, localhost,
  private hosts); otherwise `urlWithheld` is set. Freshness: fresh <= 90 days, aging <= 365, stale beyond, unknown
  when no research date is stored (undated evidence is not citable).
- Tenant scope: prospect tables are platform-wide, so a prospect linked to a customer tenant (conversion or active
  relationship) outside the grant reads as NOT_FOUND, like any out-of-scope target. A contact or venue of another
  account is NOT_FOUND. Unknown arguments are rejected (strict schema).
- Tool and property names avoid send/charge/delete/autonomy/approved (`releaseEligible`, not a send word).
- Determinism: no clock reads inside the builder (uses the call's `now`), sorted keys, stable ordering with id
  tiebreakers. The fingerprint hashes record ids and versions, not time.

**Commands and results.** Disposable DB `pathfinder_disposable_einstein_outreach` (the `pathfinder_disposable_`
prefix is required by the migration script and the test guard; migration needs `PATHFINDER_DISPOSABLE_DATABASE_URL`).

- `pnpm install --frozen-lockfile`, `prisma generate`: PASS.
- `tsc --noEmit` in packages/api and packages/contracts: PASS.
- `pnpm lint` packages/contracts: PASS. packages/api: FAIL on one pre-existing unused import in
  `operator-company-reports-billing.disposable.integration.test.ts` (not touched here); my files lint clean.
- Contracts `pnpm test`: 73 files / 729 tests PASS.
- API `pnpm test`: 310 files passed, 1 failed (`venue-qr-pdf` timeout under full-suite load; passes alone, 6/6).
- Unit `outreach-context.test.ts`: 23 PASS.
- `RUN_OPERATOR_DB_INTEGRATION=1 vitest run src/operator --pool=forks --maxWorkers=1`: 42 of 43 files pass; the one
  failure was a 10s `beforeAll` hook timeout in `operator-discovery` under load; rerun alone with a longer hook
  timeout: 8/8 PASS. New `operator-outreach-context.disposable.integration.test.ts`: 10/10 PASS (healthy pack, suppressed
  contact, unsubscribed-only account with ledger, address blocked on an archived alias, do-not-contact account, missing
  venue/contact/evidence, truncation of evidence/notes/messages, determinism and fingerprint change, cross-tenant,
  cross-account, missing capability, strict args and no writes).
- `pnpm test:scripts`: 18 failures = the 14 known admission pins plus 4 in `ci-plan-workflow-wiring.test.mjs`, which
  fail identically on the clean base commit (checked with a stash) and are unrelated.
- NOT RUN: full-repo `pnpm typecheck`/`pnpm test` for other packages (only contracts and api touched).

## Outreach continuation (2026-10-02)

Reviewed the existing A04 commit and fixed an authorization defect: the first 50 active customer
relationships cannot establish authority for the complete account. The loader now checks every
active relationship; a 51-relationship cross-tenant regression proves refusal. Recent research dates
do not establish recent news, and estimated size does not establish attendance; both claims remain
unsupported until independently verified. No network, model, mailbox or mutation was added.

The broad run also exposed portable-test defects. The dashboard boundary test now uses
`fileURLToPath`, and the billing month fixture uses local noon. The CI workflow contract normalizes
CRLF before matching YAML. Removed one unused test import. Product timezone behavior and the
staging admission script and its tests are unchanged.

Commands run from this lane root, with the handoff's synthetic local CI environment, disposable
database `pathfinder_disposable_einstein_outreach`, Redis index 3. Logs are retained in the lane's
external `qa` folder. Each shell must set this environment; it does not persist across invocations.

| Exact command                                                                                                                                                                                                                              | Result                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                                                                           | PASS                                                                                                                                                                                                                                |
| `pnpm typecheck`                                                                                                                                                                                                                           | PASS, all 27 Turbo tasks                                                                                                                                                                                                            |
| `pnpm lint`                                                                                                                                                                                                                                | Initial FAIL: unused `OperatorNotFoundError` test import; removed; rerun PASS, 15 tasks, existing warnings only                                                                                                                     |
| `pnpm test`                                                                                                                                                                                                                                | Initial FAIL: two dashboard portable-test defects; next shell FAIL from missing dummy worker configuration; final configured rerun: all 27 Turbo tasks PASS, command exits FAIL solely for the 14 frozen admission-pin script tests |
| `pnpm test:scripts`                                                                                                                                                                                                                        | Initial FAIL 18 (14 pins + 4 CRLF workflow-parser failures); final invocation inside `pnpm test`: 620 tests, 605 PASS, 14 FAIL, 1 skipped                                                                                           |
| `pnpm --dir apps/dashboard exec vitest run lib/server-client-boundary.test.ts components/billing/BillingStateView.test.tsx --pool=forks --maxWorkers=1`                                                                                    | PASS, 339 tests                                                                                                                                                                                                                     |
| `RUN_OPERATOR_DB_INTEGRATION=1 pnpm --dir packages/api exec vitest run src/operator/outreach-context.test.ts src/operator/tools/operator-outreach-context.disposable.integration.test.ts --pool=forks --maxWorkers=1 --hookTimeout=120000` | PASS, 23 unit + 11 DB tests                                                                                                                                                                                                         |

Final workspace test counts: config 108, contracts 729, AI 179, auth 76, intake-engine 15,
character-factory 14, jobs 98, UI 43, DB 2293, analytics 4, billing 87, API 3364, web 547,
workers 707, dashboard 2096 PASS. Guarded integration skips in this unit run are not DB proof;
the dbint lane owns the exhaustive integration inventory. Hosted/provider/device checks NOT RUN.

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
