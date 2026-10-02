# Torchiko implementation handoff — packet r001 (2026-10-02)

Branch `claude/exciting-einstein-bl59qp` on top of `origin/master` `26a9e7e` (the deployed production tree
`9f726af`). Not pushed (GitHub 403 for this session); a git bundle was delivered to the owner. Nothing was deployed,
migrated on a hosted database, sent, invited, charged or configured on a live provider.

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
| CRM                                    | Typed account edits, address change preserving suppression, prospect create with duplicate stop, import reads/commit bound to hashes, full notes      | Unit (DB suites skipped)                                                             |
| Client information loop                | Blocking-question reads, support create/reply proposals, one notification intent (portal now, email via worker behind default-off switch)             | Unit; no email sent                                                                  |
| Sources, content, releases             | Source capture (SSRF-safe, bounded), content reads, correction changesets (retire, not append), release reads/preflight, private signed preview       | Unit; no external fetch                                                              |
| Live data / web policy                 | Open-web browsing permanently off for visitors; read-only connectors (sports/ride/generic) via worker with freshness states                           | Unit with fixtures; no partner connectivity claimed                                  |
| Venue recommendations                  | Opt-in, deterministic eligibility/ranking (lemonade scenarios), private priority never in guest context, server-only exposure events                  | Unit (30+ scenario tests)                                                            |
| Reports, evidence, routines, attention | Full report reader, stuck-report reconciliation by job evidence, session/evidence readers, routine proposals (saved disabled), attention view         | Unit                                                                                 |
| CI                                     | Fail-safe dependency-aware plan for development branches; full suite unchanged for master/staging/promotion/merge queue                               | Script tests; GitHub timing NOT RUN                                                  |
| Business prep                          | CityPASS drafts (no Skydeck claim without evidence), NYC wave plan                                                                                    | Docs only; nothing sent                                                              |

## 2. Identity

- Final local commit: see `git rev-parse HEAD` on the branch (38 commits over master at the time of writing).
- New migrations (additive, tenanted, forward-only): `20261002090000_add_live_data_connectors`,
  `20261002091000_add_client_notification_intents`, `20261002092000_add_venue_sources`,
  `20261002100000_add_venue_recommendations` (259 total). Not applied anywhere hosted.
- Environment: container without hosted DB, Stripe/Clerk/Gmail credentials, Playwright WebKit or physical devices;
  `xlsx` installed locally from npm 0.18.5 because `cdn.sheetjs.com` is blocked (never committed).

## 3. Test results (this run, local)

| Check                                                                                    | Result                                                                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest, every package (DB-backed `*.disposable.integration` suites skipped)              | PASS: contracts 729, config 108, analytics 4, jobs 98, auth 76, db 2293, ai 179, billing 87, ui 43, api 3340, web 547, dashboard 2096, workers 707                    |
| `pnpm turbo run typecheck`                                                               | PASS after fixing six test-only type errors (dashboard error only in an untracked local Playwright wrapper)                                                           |
| `pnpm turbo run lint`                                                                    | PASS after fixing three db lint errors (pre-existing warnings remain)                                                                                                 |
| `pnpm test:scripts`                                                                      | FAIL 14 — all are staging migration-admission pins frozen at the reviewed 255 endpoint (expected until the owner admits 256–259; see §6). All other script tests PASS |
| `verify:tenant-registry`, `verify:raw-sql`, `verify:tenant-bypasses`, current-truth docs | PASS (284+ models; 261 raw SQL; 462 bypass calls / 162 files)                                                                                                         |
| Playwright visitor keyboard/composer specs (Chromium 320/390/desktop)                    | PASS 20, skipped 1                                                                                                                                                    |
| Playwright full visitor suite (Chromium projects)                                        | See journal; earlier run invalid due to dev-server memory exhaustion                                                                                                  |
| Playwright WebKit                                                                        | NOT RUN (browser not installed)                                                                                                                                       |
| Real iPhone Safari / Chrome (A29, M01–M05)                                               | NOT RUN — protocol in `torchiko-keyboard-device-protocol.md`                                                                                                          |
| Stripe sandbox lifecycle (B03, A21–A22)                                                  | NOT RUN — no sandbox keys; plan in `stripe-live-activation-checklist.md`                                                                                              |
| Disposable PostgreSQL integration suites                                                 | NOT RUN — no database in this container                                                                                                                               |

## 4. Acceptance status

PASS here means "local automated evidence for the code path"; provider/device/hosted rows are separate.

| Row                             | Status                                                           | Note                                        |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| A01 discover/add prospect       | Implemented; unit PASS; DB NOT RUN                               | duplicate stop, bound cursors               |
| A02 correct CRM data            | Implemented; unit PASS                                           | revision guard, unsupported fields rejected |
| A03 import + duplicate decision | Implemented; unit PASS; real files NOT RUN                       | 372-row CSV not in repo                     |
| A04 grounded outreach draft     | Existing paths; context pack NOT BUILT                           | see gaps                                    |
| A05 send/reconcile outreach     | NOT RUN                                                          | sending gated, unauthorized                 |
| A06 receive reply               | NOT BUILT (inbound content path absent)                          | documented gap                              |
| A07 convert prospect to client  | Implemented durability/reconcile; unit PASS                      | invitation separate                         |
| A08 private draft venue         | Existing; preview denial unit PASS                               | hosted NOT RUN                              |
| A09 ingest sources              | Implemented; unit PASS (fixtures)                                | no external fetch                           |
| A10 correct content             | Implemented changesets; unit PASS                                |                                             |
| A11 ask via portal + email      | Implemented; unit PASS; email NOT SENT                           | switch default off                          |
| A12 process replies             | Portal only; email inbound NOT BUILT                             |                                             |
| A13 preview and publish         | Private preview + release reads implemented; publication NOT RUN |                                             |
| A14 theming/access assets       | Existing; NOT RUN                                                |                                             |
| A15 notices                     | Implemented; unit PASS                                           | venue timezone field absent                 |
| A16 analyze conversations       | Readers implemented; unit PASS                                   | test sessions not distinguishable           |
| A17 finding → improvement       | Partially (evidence + changeset); end-to-end NOT RUN             |                                             |
| A18 lemonade recommendation     | Implemented; unit PASS                                           | capability off by default                   |
| A19 measure commercial change   | Raw counts only; attribution explicitly unavailable              |                                             |
| A20 complete report             | Full reader + generate/publish proposals; delivery NOT MODELLED  |                                             |
| A21 billing setup/reconcile     | State model + webhook fixes; sandbox NOT RUN                     |                                             |
| A22 billing exception           | Grace/ordering fixes unit PASS; sandbox NOT RUN                  |                                             |
| A23 routines                    | Proposals + run status; reminder stop rules NOT BUILT            |                                             |
| A24 offboarding                 | NOT CHANGED this run                                             | existing planning records only              |
| A25 chat approvals              | NOT BUILT this run (W12)                                         | approval page remains the route             |
| A26 bounded job grant           | NOT BUILT this run (W12)                                         |                                             |
| A27 partial/unknown recovery    | Customer create implemented; unit PASS                           | plan steps not covered                      |
| A28 isolation/limits            | Cross-tenant generated cases PASS; SSRF/limits unit PASS         |                                             |
| A29 real iPhone                 | NOT RUN                                                          | required to call the bug fixed              |
| M01–M05 mobile                  | Implemented; emulation PASS; device NOT RUN                      |                                             |
| B01 billing states              | Implemented; render PASS                                         |                                             |
| B02 live checklist              | Written; live inspection NOT RUN                                 |                                             |
| B03 event recovery              | Unit PASS; sandbox NOT RUN                                       |                                             |
| B04 billing access              | Server-side role checks; unit PASS                               |                                             |
| L01–L06 web policy/live data    | Implemented; fixture unit PASS                                   | no real feed                                |
| CI01–CI05                       | Implemented; script PASS                                         |                                             |
| CI06 before/after               | Baseline measured (median 52.8 min); after NOT RUN               | needs GitHub runs                           |
| H01–H03 consolidation (W14)     | NOT STARTED                                                      | sequenced after the feature wave            |
| P01 portal/branding             | Billing + look-and-feel fixes; device NOT RUN                    |                                             |
| P02 one guide across surfaces   | Existing; NOT RUN                                                |                                             |
| S01 CityPASS                    | Drafts PASS (unsent)                                             | contact not selected                        |
| S02 NYC plan                    | PASS (plan only)                                                 |                                             |

## 5. Root causes found (evidence in the journal)

1. iPhone blank band: measurement loop mixed client-rect frames (iOS visual vs Chromium layout) and added the pan
   twice. 2. Clipped hint: WebKit wraps textarea placeholders. 3. Operator page: `OPERATOR_TABS.find()` on a client
   reference during server render (commit 3917966). 4. Unknown create: pre-persistence failures labelled unknown.
2. Billing blank: panel returned null when disabled; all errors collapsed to "not available". 6. Master CI red:
   fenced-click race in a test.

## 6. Decisions and approvals needed from Tom

1. **Real-iPhone test** of the candidate (Safari + Chrome) using the protocol; this gates calling the bug fixed.
2. **Admit migrations 256–259** in the staging admission pins (`scripts/run-staging-migration-predeploy.mjs` and
   tests). The automated safety check refused to let me change release-gate pins; this needs your review.
3. **Security review** of the new raw-SQL lock (`tenant-support-operation-lock`) and the live-data scheduler's
   tenant-isolation bypass (discovers opaque IDs only).
4. **Production reconciliation** of operation `36b36c4b-…` (read-only checks in the runbook).
5. **Stripe**: sandbox keys for the lifecycle test; live catalog, webhook, portal and tax decisions (checklist).
6. Venue timezone field (notices), notice precedence order (priority-first kept), client email enablement, routine
   dollar budgets, report recipients, test-session flag, CityPASS contact and draft choice.
7. GitHub access for this session (push 403) and allowing `cdn.sheetjs.com`.

## 7. Not done (honest scope)

- W12 authenticated chat approvals and bounded job grants: not built this run.
- W14 whole-codebase consolidation: not started (it follows the feature wave and needs an owner checkpoint).
- Outreach context pack, inbound reply ingestion, offboarding execution, CI timing after measurement.
- Workers import `@pathfinder/api` subpaths in several existing processors (and the new source-capture processor),
  contrary to CLAUDE.md; this predates the run and should be resolved in W14.

## 8. Release and rollback proposal — NOT executed, needs separate approval

1. Restore GitHub access; push the branch; open a PR to `master`.
2. Owner admits migrations 256–259 in the staging admission pins (reviewed change), then full CI must be green on
   the exact PR head (ci, visitor-launch, railway-iac; full suite forced for promotion).
3. Staging: follow the existing gated runbook — freeze source, drain writers, fresh backup, disposable restore and
   rehearsal of only 256–259, verify original-table hashes/counts, apply via `db:migrate:prod` path for staging,
   release web → dashboard → workers at the exact SHA, exact three-service admission. All new switches stay off
   (client email, live data hosts, recommendations capability, preview secret unset ⇒ preview disabled).
4. Real-iPhone test on staging (protocol), Stripe sandbox lifecycle, operator page smoke.
5. Production: new scoped release record naming the exact SHA and migrations 256–259; same backup/rehearsal gates;
   promote the exact admitted source.
6. Rollback: migrations are additive; roll the application back to `9f726af` after draining writers; keep the new
   tables (no destructive down migration). The visitor viewport change is self-contained in `apps/web` and reverts
   with the application.
