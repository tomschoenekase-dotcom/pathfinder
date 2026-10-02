# Torchiko implementation handoff — packet r001 (2026-10-02)

Delivery branch: `claude/exciting-einstein-bl59qp`; [PR #40](https://github.com/tomschoenekase-dotcom/pathfinder/pull/40)
targets `codex/pathfinder-v2-staging`. This continuation integrates all six interrupted lanes and a measured W14 slice.
Final remote-head CI is checked after the non-force push and retained in the local delivery receipt.
Nothing was deployed, migrated on a hosted database, sent, invited, charged or configured on a live provider.

## 1. What now works (business level)

| Journey                                | Implemented now                                                                                                                                       | Verified how                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Visitor chat on iPhone                 | One viewport model (shell = visual viewport); valid send dismisses the keyboard immediately; no refocus while answering; clean one-line hint          | Unit + Chromium emulation PASS; **real iPhone NOT RUN**                              |
| Operator console `/admin/operator`     | Root cause fixed (server page used a value from a client module); per-section honest errors                                                           | Unit + boundary test; production confirmation NOT RUN                                |
| Client `/look-and-feel`                | Same defect class fixed                                                                                                                               | Boundary test fails on old shape                                                     |
| Unknown customer create                | Failures before recording now say "not recorded, no effect"; real unknowns reconcile against Clerk by operation id; retries refused until reconciled  | Unit (16 durability cases); production reconciliation BLOCKED (owner-approved reads) |
| Paginated operator lists               | Cursors bound to the issuing query; honest `complete`                                                                                                 | Unit                                                                                 |
| Client billing page                    | 14 explicit states, never blank, errors never shown as "no subscription"; webhook tenant-mismatch quarantine, ordering, grace and live-fixture guards | Unit/render; Stripe sandbox NOT RUN (no keys)                                        |
| Temporary notices                      | Shared lifecycle; `isActive` never means live; idempotent end                                                                                         | Unit                                                                                 |
| CRM                                    | Typed edits, suppression-safe outreach context, duplicate decisions and bounded imports                                                               | Unit + disposable DB proof; no outreach sent                                         |
| Client information loop                | Support proposals, notification intents and bounded inbound reply linking                                                                             | Unit + disposable DB proof; no email sent                                            |
| Sources, content, releases             | Source capture (SSRF-safe, bounded), content reads, correction changesets (retire, not append), release reads/preflight, private signed preview       | Unit; no external fetch                                                              |
| Live data / web policy                 | Open-web browsing permanently off for visitors; read-only connectors (sports/ride/generic) via worker with freshness states                           | Unit with fixtures; no partner connectivity claimed                                  |
| Venue recommendations                  | Opt-in, deterministic eligibility/ranking (lemonade scenarios), private priority never in guest context, server-only exposure events                  | Unit (30+ scenario tests)                                                            |
| Reports, evidence, routines, attention | Report/attention readers, disabled-by-default routine proposals, stop rules and estimated budget reservations                                         | Unit + disposable DB proof; no provider spend claim                                  |
| CI                                     | Fail-safe dependency-aware plan for development branches; full suite unchanged for master/staging/promotion/merge queue                               | Script tests; GitHub timing NOT RUN                                                  |
| Business prep                          | CityPASS drafts (no Skydeck claim without evidence), NYC wave plan                                                                                    | Docs only; nothing sent                                                              |

## 2. Identity

- Integration worktree: `20261002-einstein-finish/worktree`; local branch `claude/exciting-einstein-bl59qp-restore`.
- Starting remote head: `415134988fb9696160d764f79e2d01a317d6ed4f`. Source proof and exact commands are in the journal and local `../qa/final-*` receipts; final commit identity is `git rev-parse HEAD`.
- 265 migration files. Added lane migrations: `20261002110000` decisions/job grants, `20261002111000` inbound replies, `20261002112000` routine budgets, `20261002113000` offboarding execution, integrator-reviewed `20261002114000` deterministic credential capability collation, and `20261002115000` client-reported voice usage classification.
- The collation migration replaces only the evidence-trigger ordering expression; allowlists and evidence checks remain identical. The voice migration adds the runtime CLIENT_REPORTED value to the existing usage check without promoting it to provider-observed spend. No existing migration, credential or usage data was rewritten. All 265 applied only to disposable local PostgreSQL 16/pgvector.
- Local proof uses synthetic credentials and loopback PostgreSQL/Redis/storage. No hosted-provider or physical-device proof is implied.

## 3. Test results (local continuation)

Commands ran serially through `../qa/final-checks.ps1` with the packet's synthetic environment. The journal retains earlier failures and their corrective reruns. Full workspace proof used a7fb1502; follow-up source 57b90ac0 passed typecheck, lint and 14 readiness tests. Final script proof includes the final documentation and admin procedure inventory correction.

| Check                                                                                                                                                                            | Result                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                                                                 | PASS                                                                                                                    |
| `pnpm --dir packages/db exec prisma generate`                                                                                                                                    | PASS                                                                                                                    |
| Fresh disposable database + `pnpm db:migrate:disposable --database pathfinder_disposable_einstein_finish_final2 --confirm-database pathfinder_disposable_einstein_finish_final2` | PASS — 265 migrations; local only                                                                                       |
| `pnpm typecheck --concurrency=2`                                                                                                                                                 | PASS                                                                                                                    |
| `pnpm lint --concurrency=2`                                                                                                                                                      | PASS                                                                                                                    |
| `pnpm test`                                                                                                                                                                      | FAIL — 10,547 workspace tests passed; bundled script phase failed, detailed in journal                                  |
| `pnpm test:scripts`                                                                                                                                                              | FAIL — final corrected rerun: 607 PASS, 12 FAIL, 1 SKIP (620 tests)                                                     |
| Tenant registry / bypass / raw SQL / tenant-procedure gates                                                                                                                      | PASS / PASS / PASS / PASS                                                                                               |
| Operator unit + disposable suites, serial fork                                                                                                                                   | PASS — Test Files 47 passed (47); Tests 636 passed (636)                                                                |
| New inbound/routine DB suites, serial fork                                                                                                                                       | PASS — Test Files 2 passed (2); Tests 33 passed (33)                                                                    |
| Exhaustive DB/Redis/storage lane                                                                                                                                                 | PASS — all 176 final-tree integration files have passing lane/root/targeted evidence; not one monolithic final-head run |
| W14 storage policy + compatibility exports                                                                                                                                       | PASS — 4 config + 4 API tests                                                                                           |
| Responsive guest Playwright journey                                                                                                                                              | PASS — 6/6 on Chromium at 390, 820 and 1440px; phone screenshot inspected                                               |
| W12 authenticated grant screen browser rendering                                                                                                                                 | NOT RUN — no provider-dark guarded-page fixture; route/component/a11y tests passed                                      |
| Real iPhone Safari/Chrome, WebKit, Stripe sandbox, hosted smoke                                                                                                                  | NOT RUN                                                                                                                 |

Twelve frozen-pin failures remain release blockers. The original 14 included two documentation-safety failures, now PASS after removing obsolete executable hosted instructions and marking historical command receipts inert. The frozen 255 endpoint and its tests were not edited. No non-pin failure is to be counted as an expected pass.

## 4. Acceptance status

PASS here means "local automated evidence for the code path"; provider/device/hosted rows are separate.

| Row                             | Status                                                           | Note                                                                                  |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A01 discover/add prospect       | Implemented; unit + disposable DB PASS                           | duplicate stop, bound cursors                                                         |
| A02 correct CRM data            | Implemented; unit PASS                                           | revision guard, unsupported fields rejected                                           |
| A03 import + duplicate decision | Implemented; unit PASS; real files NOT RUN                       | 372-row CSV not in repo                                                               |
| A04 grounded outreach draft     | Implemented; unit + disposable DB PASS                           | bounded context, full relationship scope, explicit unsupported claims                 |
| A05 send/reconcile outreach     | NOT RUN                                                          | sending gated, unauthorized                                                           |
| A06 receive reply               | Implemented; provider-dark DB PASS                               | unique anchor + sender match; ambiguous/overflow quarantined; no live mailbox proof   |
| A07 convert prospect to client  | Implemented durability/reconcile; unit PASS                      | invitation separate                                                                   |
| A08 private draft venue         | Existing; preview denial unit PASS                               | hosted NOT RUN                                                                        |
| A09 ingest sources              | Implemented; unit PASS (fixtures)                                | no external fetch                                                                     |
| A10 correct content             | Implemented changesets; unit PASS                                |                                                                                       |
| A11 ask via portal + email      | Implemented; unit PASS; email NOT SENT                           | switch default off                                                                    |
| A12 process replies             | Portal + linked inbound email evidence                           | moves waiting request to review; never auto-completes it                              |
| A13 preview and publish         | Private preview + release reads implemented; publication NOT RUN |                                                                                       |
| A14 theming/access assets       | Existing; NOT RUN                                                |                                                                                       |
| A15 notices                     | Implemented; unit PASS                                           | venue timezone field absent                                                           |
| A16 analyze conversations       | Readers implemented; unit PASS                                   | test sessions not distinguishable                                                     |
| A17 finding → improvement       | Partially (evidence + changeset); end-to-end NOT RUN             |                                                                                       |
| A18 lemonade recommendation     | Implemented; unit PASS                                           | capability off by default                                                             |
| A19 measure commercial change   | Raw counts only; attribution explicitly unavailable              |                                                                                       |
| A20 complete report             | Full reader + generate/publish proposals; delivery NOT MODELLED  |                                                                                       |
| A21 billing setup/reconcile     | State model + webhook fixes; sandbox NOT RUN                     |                                                                                       |
| A22 billing exception           | Grace/ordering fixes unit PASS; sandbox NOT RUN                  |                                                                                       |
| A23 routines                    | Stop rules + estimated dollar reservations; DB PASS              | email/portal reply stops; global prospect bindings refused; no actual-spend cap claim |
| A24 offboarding                 | Scoped durable local execution; DB PASS                          | resume checks live state; identity-provider removal and billing remain manual         |
| A25 chat approvals              | Authenticated decision requests implemented; DB/route PASS       | MCP requests a decision link; only reverified owner decides                           |
| A26 bounded job grant           | Bounded grant lifecycle + human-triggered apply; DB PASS         | appearance only; no MCP grant consumption or unattended scheduler                     |
| A27 partial/unknown recovery    | Customer-create and local offboarding recovery tested            | hosted reconciliation NOT RUN; partial effects never called no-effect                 |
| A28 isolation/limits            | Cross-tenant generated cases PASS; SSRF/limits unit PASS         |                                                                                       |
| A29 real iPhone                 | NOT RUN                                                          | required to call the bug fixed                                                        |
| M01–M05 mobile                  | Implemented; emulation PASS; device NOT RUN                      |                                                                                       |
| B01 billing states              | Implemented; render PASS                                         |                                                                                       |
| B02 live checklist              | Written; live inspection NOT RUN                                 |                                                                                       |
| B03 event recovery              | Unit PASS; sandbox NOT RUN                                       |                                                                                       |
| B04 billing access              | Server-side role checks; unit PASS                               |                                                                                       |
| L01–L06 web policy/live data    | Implemented; fixture unit PASS                                   | no real feed                                                                          |
| CI01–CI05                       | Implemented; script PASS                                         |                                                                                       |
| CI06 before/after               | Baseline measured (median 52.8 min); after NOT RUN               | needs GitHub runs                                                                     |
| H01–H03 consolidation (W14)     | Conservative slice PASS; larger boundary cleanup remains         | worker production API-import files 11 → 10; compatibility export retained             |
| P01 portal/branding             | Billing + look-and-feel fixes; device NOT RUN                    |                                                                                       |
| P02 one guide across surfaces   | Existing; NOT RUN                                                |                                                                                       |
| S01 CityPASS                    | Drafts PASS (unsent)                                             | contact not selected                                                                  |
| S02 NYC plan                    | PASS (plan only)                                                 |                                                                                       |

## 5. Root causes found (evidence in the journal)

1. iPhone blank band: measurement loop mixed client-rect frames (iOS visual vs Chromium layout) and added the pan
   twice. 2. Clipped hint: WebKit wraps textarea placeholders. 3. Operator page: `OPERATOR_TABS.find()` on a client
   reference during server render (commit 3917966). 4. Unknown create: pre-persistence failures labelled unknown.
2. Billing blank: panel returned null when disabled; all errors collapsed to "not available". 6. Master CI red:
   fenced-click race in a test.

## 6. Decisions and approvals needed from Tom

1. Review and admit the exact migration suffix 256–265 separately before promotion. The staging pins remain frozen at 255 and produce 12 remaining pin failures.
2. Venue timezone migration and the existing documentation name replacement remain waiting for Tom's yes. Neither was performed.
3. Run the real-iPhone Safari/Chrome protocol before declaring the keyboard/viewport journey fixed on device; run the Stripe sandbox lifecycle before any billing-readiness claim.
4. Review the new offboarding tenant/plan lock, bounded inbound ownership discovery, and deterministic credential collation migration as part of release admission. Rehearsal must check compatibility with existing credential capability order without rewriting credential data.
5. Offboarding identity-provider access removal, retained sessions and billing-provider state require separate human verification. Local membership/status fields are not a complete application-access revocation boundary.
6. The earlier unknown customer-create operation still needs the scoped read-only production reconciliation in the runbook. New email enablement, provider effects and production release need their own authorization.

## 7. Not done (honest scope)

- No deploy, hosted migration, live-provider call, email or invitation, purchase, branch-protection change or staging-pin edit.
- The 12 frozen admission-pin failures are not fixed; all original 14 are classified in the journal. Exact-head CI may remain red at this gate; the delivery receipt records actual check outcomes.
- Real iPhone/WebKit, Stripe sandbox, hosted operator/offboarding smoke and the W12 guarded-page browser check remain NOT RUN.
- Bounded job grants support an explicit human Apply action for opted-in appearance changes; no autonomous scheduler consumes them.
- Routine budgets reserve a configured per-run estimate, not observed provider spend. Global prospect-contact routines remain refused until a tenant-safe relation exists.
- Offboarding local execution does not remove Clerk memberships/sessions or cancel billing. Those manual obligations remain visible. Reinstatement does not resurrect credentials, sessions or paused schedules.
- W14 is one measured extraction, not whole-codebase consolidation. Ten production worker files still import API subpaths; those migrations need separate reviewed slices.
- Venue timezone schema and the existing documentation name replacement wait for Tom's yes. Existing named rows were preserved, not duplicated in new content.

## 8. Release and rollback proposal — NOT executed

1. Keep PR #40 on the protected staging path. Review all local proof and exact-head CI; resolve non-pin failures and separately authorize the final 256–265 admission before promotion. Do not bypass the frozen gate.
2. Staging proposal: freeze the exact source, drain writers, take a fresh backup, and rehearse all ten unadmitted migrations on a disposable restore. Compare original-table hashes/counts, review existing capability ordering for the trigger change, and retain the exact manifest and migration ledger.
3. Only after separate approval, use the existing gated migration/release runbook and exact three-service admission. Keep new email, offboarding and provider-related switches off. Run authenticated owner approval, offboarding recovery, guest-device and Stripe sandbox protocols before enabling corresponding journeys.
4. Production requires a new scoped decision naming the exact tested SHA, migration manifest, backup and staging evidence. Nothing in this handoff grants that decision.
5. Rollback proposal: drain writers and restore the previously admitted application SHA (the packet's baseline is `9f726af`; re-verify the release record before use). Retain additive tables and audit evidence; do not run destructive down migrations. The collation and client-reported usage migrations replace an existing trigger/check, so separately review compatibility rather than treating it as a removable table.
6. Reconcile partially applied offboarding using durable receipts before retrying. Application rollback cannot restore identity-provider membership, revoked credentials or payment-provider state; those need a person and their own evidence.

## 9. Historical pause point (prior cloud session)

PR CI on the pushed branch (head `8e8c284`) reported: visitor-launch and railway-iac PASS; CI plan FAIL
("Unable to locate executable file: pnpm"); operator kinds integration test FAIL (36 expected, 44 registered);
promotion gate FAIL (head branch is not `codex/pathfinder-v2-staging`). Fixed in `da9ee1d`:

- CI plan job: `package-manager-cache: false` on setup-node (v5 auto-enables pnpm caching from `packageManager`).
- Kinds integration test expects all 44 kinds.
- Real defect: `operator.get_context` scope note could exceed its 300-char schema limit for limited connections.
- Real defect: support create-request with a recipient who left the tenant is now STALE, not NOT_FOUND.
- Billing cross-tenant cursor assertion expects INVALID_CURSOR (bound cursors refuse earlier).

Verified locally on PostgreSQL 16 + pgvector with all 259 migrations applied through the disposable guard:
all 41 operator test files, 510 tests PASS (RUN_OPERATOR_DB_INTEGRATION=1). The remaining integration suites
(db, jobs, billing, api non-operator, workers, dashboard) were started but NOT finished — rerun locally.

Process: the promotion gate only admits PRs into `master` from `codex/pathfinder-v2-staging` whose exact head is
healthy on staging. Retarget this PR to `codex/pathfinder-v2-staging` (or open a new one there).
