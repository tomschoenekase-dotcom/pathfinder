# Torchiko implementation handoff — packet r001 (2026-10-02)

Delivery branch: `claude/exciting-einstein-bl59qp`; [PR #40](https://github.com/tomschoenekase-dotcom/pathfinder/pull/40)
targets `codex/pathfinder-v2-staging`. This continuation integrates all six interrupted lanes and a measured W14 slice.
Final remote-head CI is checked after the non-force push and retained in the local delivery receipt.
Nothing was deployed, migrated on a hosted database, sent, invited, charged or configured on a live provider.

## 1. What now works (business level)

| Journey                                | Implemented now                                                                                                                                       | Verified how                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Visitor chat on iPhone                 | One viewport model (shell = visual viewport); valid send dismisses the keyboard immediately; no refocus while answering; clean one-line hint          | Unit + Chromium and WebKit emulation PASS; **real iPhone NOT RUN**                   |
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
- 267 migration files. The current continuation adds local-only `20261002120000` Gmail draft references and `20261002121000` organization merge receipts; both require release admission. Earlier lane additions follow. Added lane migrations: `20261002110000` decisions/job grants, `20261002111000` inbound replies, `20261002112000` routine budgets, `20261002113000` offboarding execution, integrator-reviewed `20261002114000` deterministic credential capability collation, and `20261002115000` client-reported voice usage classification.
- The collation migration replaces only the evidence-trigger ordering expression; allowlists and evidence checks remain identical. The voice migration adds the runtime CLIENT_REPORTED value to the existing usage check without promoting it to provider-observed spend. No existing migration, credential or usage data was rewritten. All 265 applied only to disposable local PostgreSQL 16/pgvector.
- Local proof uses synthetic credentials and loopback PostgreSQL/Redis/storage. No hosted-provider or physical-device proof is implied.

## 3. Test results (local continuation)

The latest CRM continuation results are in section 11; the following table preserves the earlier lane integration evidence.

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
| Real iPhone Safari/Chrome, Stripe sandbox, hosted smoke                                                                                                                          | NOT RUN                                                                                                                 |

Twelve frozen-pin failures remain release blockers. The original 14 included two documentation-safety failures, now PASS after removing obsolete executable hosted instructions and marking historical command receipts inert. The frozen 255 endpoint and its tests were not edited. No non-pin failure is to be counted as an expected pass.

## 4. Acceptance status

PASS here means "local automated evidence for the code path"; provider/device/hosted rows are separate.

| Row                             | Status                                                                              | Note                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A01 discover/add prospect       | Implemented; unit + disposable DB PASS                                              | duplicate stop, bound cursors                                                         |
| A02 correct CRM data            | Implemented; unit PASS                                                              | revision guard, unsupported fields rejected                                           |
| A03 import + duplicate decision | Native CSV, mapping/resume, exact field retention and reviewed merge; local DB PASS | Ambiguous duplicates require review; original 372-row file NOT RUN                    |
| A04 grounded outreach draft     | Implemented; unit + disposable DB PASS                                              | bounded context, full relationship scope, explicit unsupported claims                 |
| A05 send/reconcile outreach     | NOT RUN                                                                             | sending gated, unauthorized                                                           |
| A06 receive reply               | Initial/incremental Gmail reconciliation + linked replies; local DB PASS            | unique anchor + sender match; ambiguous/overflow quarantined; no live mailbox proof   |
| A07 convert prospect to client  | Implemented durability/reconcile; unit PASS                                         | invitation separate                                                                   |
| A08 private draft venue         | Existing; preview denial unit PASS                                                  | hosted NOT RUN                                                                        |
| A09 ingest sources              | Implemented; unit PASS (fixtures)                                                   | no external fetch                                                                     |
| A10 correct content             | Implemented changesets; unit PASS                                                   |                                                                                       |
| A11 ask via portal + email      | Implemented; unit PASS; email NOT SENT                                              | switch default off                                                                    |
| A12 process replies             | Portal + linked inbound email evidence                                              | moves waiting request to review; never auto-completes it                              |
| A13 preview and publish         | Private preview + release reads implemented; publication NOT RUN                    |                                                                                       |
| A14 theming/access assets       | Existing; NOT RUN                                                                   |                                                                                       |
| A15 notices                     | Implemented; unit PASS                                                              | venue timezone field absent                                                           |
| A16 analyze conversations       | Readers implemented; unit PASS                                                      | test sessions not distinguishable                                                     |
| A17 finding → improvement       | Partially (evidence + changeset); end-to-end NOT RUN                                |                                                                                       |
| A18 lemonade recommendation     | Implemented; unit PASS                                                              | capability off by default                                                             |
| A19 measure commercial change   | Raw counts only; attribution explicitly unavailable                                 |                                                                                       |
| A20 complete report             | Full reader + generate/publish proposals; delivery NOT MODELLED                     |                                                                                       |
| A21 billing setup/reconcile     | State model + webhook fixes; sandbox NOT RUN                                        |                                                                                       |
| A22 billing exception           | Grace/ordering fixes unit PASS; sandbox NOT RUN                                     |                                                                                       |
| A23 routines                    | Stop rules + estimated dollar reservations; DB PASS                                 | email/portal reply stops; global prospect bindings refused; no actual-spend cap claim |
| A24 offboarding                 | Scoped durable local execution; DB PASS                                             | resume checks live state; identity-provider removal and billing remain manual         |
| A25 chat approvals              | Exact proposal descriptions + authenticated decision/resume; DB/route PASS          | MCP requests a decision link; only reverified owner decides                           |
| A26 bounded job grant           | Bounded grant lifecycle + human-triggered apply; DB PASS                            | appearance only; no MCP grant consumption or unattended scheduler                     |
| A27 partial/unknown recovery    | Customer-create and local offboarding recovery tested                               | hosted reconciliation NOT RUN; partial effects never called no-effect                 |
| A28 isolation/limits            | Cross-tenant generated cases PASS; SSRF/limits unit PASS                            |                                                                                       |
| A29 real iPhone                 | NOT RUN                                                                             | required to call the bug fixed                                                        |
| M01–M05 mobile                  | Implemented; emulation PASS; device NOT RUN                                         |                                                                                       |
| B01 billing states              | Implemented; render PASS                                                            |                                                                                       |
| B02 live checklist              | Written; live inspection NOT RUN                                                    |                                                                                       |
| B03 event recovery              | Unit PASS; sandbox NOT RUN                                                          |                                                                                       |
| B04 billing access              | Server-side role checks; unit PASS                                                  |                                                                                       |
| L01–L06 web policy/live data    | Implemented; fixture unit PASS                                                      | no real feed                                                                          |
| CI01–CI05                       | Implemented; script PASS                                                            |                                                                                       |
| CI06 before/after               | Baseline measured (median 52.8 min); after NOT RUN                                  | needs GitHub runs                                                                     |
| H01–H03 consolidation (W14)     | Conservative slice PASS; larger boundary cleanup remains                            | worker production API-import files 11 → 10; compatibility export retained             |
| P01 portal/branding             | Billing + look-and-feel fixes; device NOT RUN                                       |                                                                                       |
| P02 one guide across surfaces   | Existing; NOT RUN                                                                   |                                                                                       |
| S01 CityPASS                    | Drafts PASS (unsent)                                                                | contact not selected                                                                  |
| S02 NYC plan                    | PASS (plan only)                                                                    |                                                                                       |

## 5. Root causes found (evidence in the journal)

1. iPhone blank band: measurement loop mixed client-rect frames (iOS visual vs Chromium layout) and added the pan
   twice. 2. Clipped hint: WebKit wraps textarea placeholders. 3. Operator page: `OPERATOR_TABS.find()` on a client
   reference during server render (commit 3917966). 4. Unknown create: pre-persistence failures labelled unknown.
2. Billing blank: panel returned null when disabled; all errors collapsed to "not available". 6. Master CI red:
   fenced-click race in a test.

## 6. Decisions and approvals needed from Tom

1. Review and admit the exact migration suffix 256–267 separately before promotion. The staging pins remain frozen at 255 and produce 12 remaining pin failures.
2. Venue timezone migration and the existing documentation name replacement remain waiting for Tom's yes. Neither was performed.
3. Run the real-iPhone Safari/Chrome protocol before declaring the keyboard/viewport journey fixed on device; run the Stripe sandbox lifecycle before any billing-readiness claim.
4. Review the new offboarding tenant/plan lock, bounded inbound ownership discovery, and deterministic credential collation migration as part of release admission. Rehearsal must check compatibility with existing credential capability order without rewriting credential data.
5. Offboarding identity-provider access removal, retained sessions and billing-provider state require separate human verification. Local membership/status fields are not a complete application-access revocation boundary.
6. The earlier unknown customer-create operation still needs the scoped read-only production reconciliation in the runbook. New email enablement, provider effects and production release need their own authorization.

## 7. Not done (honest scope)

- Native Gmail draft-resource synchronization (`drafts.list/get`) is NOT IMPLEMENTED. Message/thread IDs and nullable draft references are distinct; unknown draft references are not fabricated. Live initial/incremental sync, watch activation and deployed native-file upload remain NOT RUN.
- Model selection remains `gpt-6-luna`, as Tom explicitly confirmed. Live overrides were not inspected. Explicit stable-prefix caching and separate read/write token accounting are implemented locally; live cache-hit rates, latency and savings remain NOT RUN.
- Complex account merges (active work, inbound/review/onboarding graphs, tenant links, identity collisions or weaker stop state) are refused with explicit blockers. Broader resolution remains future reviewed work.

- No deploy, hosted migration, live-provider call, email or invitation, purchase, branch-protection change or staging-pin edit.
- The 12 frozen admission-pin failures are not fixed; all original 14 are classified in the journal. Exact-head CI may remain red at this gate; the delivery receipt records actual check outcomes.
- Physical iPhone Safari, Stripe sandbox, hosted operator/offboarding smoke and the W12 guarded-page browser check remain NOT RUN.
- Bounded job grants support an explicit human Apply action for opted-in appearance changes; no autonomous scheduler consumes them.
- Routine budgets reserve a configured per-run estimate, not observed provider spend. Global prospect-contact routines remain refused until a tenant-safe relation exists.
- Offboarding local execution does not remove Clerk memberships/sessions or cancel billing. Those manual obligations remain visible. Reinstatement does not resurrect credentials, sessions or paused schedules.
- W14 is one measured extraction, not whole-codebase consolidation. Ten production worker files still import API subpaths; those migrations need separate reviewed slices.
- Venue timezone schema and the existing documentation name replacement wait for Tom's yes. Existing named rows were preserved, not duplicated in new content.

## 8. Release and rollback proposal — NOT executed

1. Keep PR #40 on the protected staging path. Review all local proof and exact-head CI; resolve non-pin failures and separately authorize the final 256–267 admission before promotion. Do not bypass the frozen gate.
2. Staging proposal: freeze the exact source, drain writers, take a fresh backup, and rehearse all twelve unadmitted migrations on a disposable restore. Compare original-table hashes/counts, review existing capability ordering for the trigger change, and retain the exact manifest and migration ledger.
3. Only after separate approval, use the existing gated migration/release runbook and exact three-service admission. Keep new email, offboarding and provider-related switches off. Run authenticated owner approval, offboarding recovery, guest-device and Stripe sandbox protocols before enabling corresponding journeys.
4. Production requires a new scoped decision naming the exact tested SHA, migration manifest, backup and staging evidence. Nothing in this handoff grants that decision.
5. Rollback proposal: drain writers and restore the previously admitted application SHA (the packet's baseline is `9f726af`; re-verify the release record before use). Retain additive tables and audit evidence; do not run destructive down migrations. The collation and client-reported usage migrations replace an existing trigger/check, so separately review compatibility rather than treating it as a removable table.
6. Pause import and merge writers before application rollback. Retain created CRM records, archived source IDs, source history and merge/import receipts; rollback is not an unmerge. Reconcile partially applied offboarding using durable receipts before retrying. Application rollback cannot restore identity-provider membership, revoked credentials or payment-provider state; those need a person and their own evidence.

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

## 10. Safari and CRM follow-up (2026-10-02)

- WebKit reproduced a Send tap lost during a viewport shift. Touch release now submits once, with swipe/cancel and duplicate-click guards; keyboard and mouse paths remain. Removing hover opacity fixed 4.43:1 button contrast. Local WebKit matrix: PASS 27, eight intentional project skips; ChatWindow: PASS 41. Physical iPhone, software keyboard and VoiceOver: NOT RUN.
- Native MCP CSV attachments or inline CSV now stage durable rows, skip exact duplicates and expose unresolved rows. A ready receipt supplies complete commit arguments, including a stable distinct operation ID. Disposable proof: 20 input rows, seven existing duplicates skipped, 13 created. Ambiguous matches block; this result is not promised for arbitrary files.
- Partial imports cannot commit; concurrent and expired-link retries recover the original receipt. Corrected CSV bytes require a new staging operation ID. Limits are 100 KB, 500 rows and 50 columns per file. Signed file URLs, file IDs and CSV contents are redacted from operator audit payloads.
- Routine CRM edits/imports, private venue creation and appearance changes default to automatic application. Explicit stored ASK settings and always-reviewed effects remain authoritative. Routine automatic writes no longer fall back to human approval after 120/hour; burst throttles and host subscription/tool-confirmation limits still apply.
- Consent, settings, embedded manual and per-kind context now describe the actual policy. Research uses the host's web tools with sourced CRM notes; the MCP is not a general web search engine. Source capture retains authorized-origin requirements.
- One authorized read-only MCP context check confirmed the installed connection is reachable with platform scope and 18 capabilities, but runs older release `9f726afd101cc3a3cb3c96d9504e06adc9618642`, catalog v0. Local catalog v1 and attachment support require a separately approved release and host tool refresh. No hosted write occurred.
- Prior head `ba0465b6` CI failed at public API surface inventory. The reviewed guarded decision/job-grant routes are now inventoried; local inventory verification PASS. The frozen staging-admission pins remain untouched.
- Follow-up source `5c9896e4`: install, full typecheck/lint and final API checks PASS; serial workspace PASS 10,565 tests; fresh operator suite PASS 51 files / 662 tests; canonical CRM suites PASS 2. Exact commands and all intermediate failures are in the journal and `../qa/crm-safari-*`. Script results and final exact-head CI are in the delivery receipt.
- Release/rollback remains the unexecuted proposal in section 8. Add native attachment staging/commit, routine writes, explicit ASK and real-device Send checks to staging acceptance; retain durable import receipts through rollback. Before reverting to older code without the completion guard, pause import writers and reconcile or cancel incomplete MCP CSV imports through canonical tools; application rollback does not undo created prospect records. No new migration was introduced by this follow-up.

## 11. CRM current-mail and import review pause (2026-10-02)

CRM code proof head: `4c7fc81d` (full SHA in the external sealed-run receipt); the earlier integrated proof below used `50967da98c700a1da2bf112f3df02423ab2ffcc8`. Subsequent cache changes and their proof are recorded separately. All six original lanes and the Gmail/import/merge continuation are committed. Delivery remains PR #40 into staging, with no deployment. The current local MCP catalog is v2, server 1.2.0, manual v5; installed older servers do not gain these tools until a separately authorized release and host refresh.

Gmail connection queues watch renewal and initial reconciliation independently. Manual UI/MCP reconciliation supplies an inspectable job ID; bounded continuation and compare-and-set cursor completion preserve replay. The initial cursor is captured before listing to avoid missing arrivals. Draft-labelled messages are not recorded as sent, and sent evidence never implies verified delivery. Imported Gmail/status claims remain unverified source evidence.

CSV/source imports expose mapping, selected sheets, phase/counts/errors/recovery, exact source-field pages and per-field retention hashes. Explicit existing account/location IDs and case-insensitive address matching distinguish parent organizations from locations. The 35,623-character provenance test and synthetic 20-input/7-duplicate/13-created replay test pass on the fresh integration database. Account merges require an exact preview and human approval, preserve contacts and outbound history, retain immutable source records through lineage, and refuse unsafe graphs or weakened stop states. Routine writes retain the owner's standing policy; host confirmations and subscription limits are independent.

Final review corrections preserve supplied street/country/postal/parent identity during native CSV duplicate handling and refuse native CSV failed rows at both proposal and canonical approval boundaries. Gmail setup failures now update the durable receipt and sanitized diagnostic signal; status reads use bounded, cancellable requests. The CRM thread extraction preserves existing procedures and guards. Source inventories reflect 585 mounted operations and 467 reviewed bypass calls across 165 files; runtime Prisma namespace access was removed without changing serializable merge transactions.

Current integrated proof: install, Prisma generation, all 267 local migrations, full typecheck (27 tasks), full lint (15 tasks), and operator sweep (58 files/690 tests) PASS. CRM merge/import/package cases PASS (8), canonicalization and outreach isolated reruns PASS (1 each), inbound/routines/budgets PASS (41), attachment retention PASS (1), isolated onboarding PASS (1), admin fit/size PASS (2), and isolated agent-copy PASS (1). Four old suites assume an empty database or a fixed unique mailbox; their initial shared-database failures and separate fresh-database reruns are retained in `../qa/crm-current-final-*.log`. No product fix was made for fixture isolation.

Sealed CRM proof: fresh operator sweep PASS 58 files / 693 tests; CRM merge/import suite PASS 8 tests; all six boundary checks PASS. `pnpm test:scripts` reports 607 PASS, 12 frozen admission-pin FAIL and one SKIP. The original 14 failures remain classified as 12 frozen admission-pin failures and two corrected documentation checks. Workspace testing found one PDF correctness-test timeout under load; its bounded timeout correction passes 6/6 in isolation, with the full rerun combined with subsequent cache work. Exact commands and failed attempts remain in the journal and external `qa` receipts.

Guest UI evidence: prior local WebKit matrix 27 PASS with eight intentional project skips; latest Chromium phone/tablet/desktop core journey 3 PASS after correcting a test selector to measure the existing outer composer. The displayed museum image was an existing synthetic local fixture, not a new design or deployed change. Physical iPhone/software-keyboard/VoiceOver proof remains NOT RUN.

Release and rollback remain the unexecuted section 8 proposal. Review native Gmail draft synchronization, isolated-test assumptions, exact-head CI, deployed attachment flow and physical Safari before claiming the entire CRM/phone experience finished. Venue timezone and the existing document-name replacement still wait for Tom's yes.

## 12. Prompt caching continuation (2026-10-02)

Combined code source `94bb24da48b1c7493b78b6b343d62a00cfb86976` adds explicit stable-prefix caching for supported OpenAI models and separate ordinary-input, cache-read and cache-write accounting in both response paths. Unmarked dynamic prompts avoid implicit cache writes. Existing budget ceilings already reserve the write premium; a regression proves this without loosening limits. Provider response storage remains disabled. This caches repeated input prefixes, not CRM writes or reused answers.

Featured-place context now follows the static cache boundary inside escaped untrusted data. The prompt contract advances to v23; historical evaluation evidence remains unchanged. Review the changed prompt identity before release. Focused cache/routing tests PASS 36/36, budget tests PASS 7/7, prompt/evaluation tests PASS 65/65; full combined outcomes are recorded in the journal and external delivery receipt.

Guest routing remains `gpt-6-luna`. Tom explicitly confirmed keeping GPT-6 Luna; no model migration is requested. No live model override was inspected or changed. Actual provider cache hits, savings and latency are NOT RUN and require separately authorized release measurement. Cache creation can cost more on a first use; reuse determines savings.

## 13. Review-first pause (latest instruction)

Tom requested Opus review before another CI cycle. The broad local rerun was stopped; no new push or exact-head CI was started. Latest local code SHA: `e45c41b36497d095186229e02908a5d5805d7651`; final delivery adds this documentation. Use the external `OPUS-REVIEW-HANDOFF.md` as the review entrypoint.

Combined production typecheck PASS (27 tasks), lint PASS (15 tasks), focused cache/prompt/budget checks PASS. The corrected API rerun PASS 3,471 tests with 373 opt-in skips. Full workspace rerun was interrupted before completion; subsequent `pnpm test` and boundary reruns are NOT RUN. Earlier sealed CRM proof remains 693 operator DB tests plus eight CRM DB tests PASS, six boundaries PASS, scripts 607 PASS / 12 frozen pin FAIL / one SKIP. No frozen pin was edited.

Opus should review the local committed candidate and fixes before spending another final CI cycle. Keep GPT-6 Luna per Tom. Outstanding live/device checks, native Gmail drafts, held approvals and the unexecuted release/rollback proposal remain as documented above.

## 14. Opus review and fixes (2026-10-02)

Reviewed local candidate `28e41244`; fixes are ten local commits through `2f963d50` plus this documentation. Nothing was pushed, deployed, migrated on a hosted database, sent or invited. No migration was added and no frozen admission pin was edited.

Defects fixed (each with focused tests):

- Guest chat on iPhone: text typed before the page finished loading was wiped by hydration (reproduced 4/4 in WebKit, kept 4/4 after the fix). A touch release on a disabled Send button could still trigger Stop. A quick double tap on Send stopped the answer it had just started.
- Prompt caching: a GPT-6 Luna response without `cache_write_tokens` failed after the answer may already have streamed. Unusable cache counts now bill uncertain input at the cache-write upper bound; legacy and DeepSeek shapes keep ordinary-input billing. The request shape matches OpenAI's published explicit-caching API; live hit rates and savings are still NOT RUN.
- CSV import: blank or all-empty rows failed the file or blocked approval; spacing/case variants of an address created a second venue at commit; legal-suffix normalization erased short regions; summary counters were stale. The 35,623-character field has no truncation path.
- Merges: a pair a person had confirmed distinct could still be merged; unsettled imports could keep writing to the archived source; serialization conflicts were not retried; open duplicate suggestions stayed on the archived source (the merged pair is now confirmed, others follow the survivor or are superseded); `UNSAFE_MERGE` was reported as an unknown tool failure; always-ask kinds now refuse apply when approved by policy or job grant.
- Gmail: removed messages (every draft edit) stuck incremental sync; pages silently dropped IDs beyond 100; bounces were recorded as prospect replies (now quarantined as `DELIVERY_STATUS_NOTICE`, never as verified bounce or delivery); expired-cursor resync rescanned the whole mailbox; one failing mailbox stopped the rest. SENT still never implies DELIVERED.
- Native Gmail drafts: read-only `drafts.list/get` reconciliation now runs after each reconciliation job. A linked reference is cleared only after a complete listing plus a confirmed 404, with an audit row; local draft state never becomes sent. `crm.get_mail_reconciliation` reports the counts only. Storing draft message/thread IDs and absent/last-seen state needs a migration: `docs/implementation/gmail-native-drafts-proposal.md`.
- CI did not run the merge, decision/grant or provider-draft DB suites; they are now wired in with a 120 s per-test timeout.

Still open: physical iPhone/VoiceOver, live Gmail (bounce header shapes, draft-to-sent ID behaviour), dashboard display of draft counts, unindexed import-lineage lookups, mapping-hash key order, and the 12 frozen pin failures. Venue timezone and the existing document-name replacement still await Tom's yes.

Results and exact commands are in the journal section "Opus review and fixes (2026-10-02)". The release and rollback proposal in section 8 is unchanged and NOT executed. Before release, add these to staging acceptance: early typing on a cold phone load, bounce quarantine on a real mailbox, and the native draft reconciliation counts.
