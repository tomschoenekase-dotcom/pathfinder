# Torchiko operator program: implementation journal

Handoff: "Torchiko Claude Code Implementation Handoff" (lanes H01-H10, H12-H14 active; H11 decision-needed).
No secrets or real customer content in this file. PASS / FAIL / NOT RUN is recorded with the command and environment.

## Where things stand (update this block first)

- 2026-10-01 release-prep CI: all three checks green on `6e79b6d451ff052d7db3829dde2e288f549f3017`,
  confirmed by Tom after attempt 2; see the dated entry below. PR #38 remains draft and unmerged.
- Baseline audited: `06e5745473762a18db07c5d30d0f6677c62c6103` (= `origin/master`, staging, release-b-operator at the start).
- Work branch: `machine/torchiko/20260930-operator-program`, isolated worktree. Nothing else was touched.
- Local proof environment: Windows, Node 24, `pnpm install --frozen-lockfile`, disposable Postgres (`pgvector/pgvector:pg16`,
  container `claude-operator-program-pg`, database `pathfinder_disposable_op`, all 255 migrations applied).
- Continuation baseline: `ca06dcec`; a second continuation (Sol, then Claude) on 2026-10-01 added H06 to H10 reads, H08 proposals,
  support triage, visitor notices, platform mail reads and H13 pins. The latest commit is named in the commit list below.
- Never run: production/staging deployment, live migration/provider action, real customer communication, account creation,
  new credentials, paid API use or money movement. H11 and lossless merge remain excluded; H13 is code and proposal only.

| Lane                                            | Current state and proof limits                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01-H03 contracts, canonical actions, execution | Earlier local slices implemented and covered by the operator suite. Provider health, unattended recovery and refresh-response replay remain gaps. No activation or release claim.                                                                                                                                                                                                               |
| H04 CRM                                         | Earlier identity/maintenance and duplicate review slices implemented. Lossless merge untouched and excluded.                                                                                                                                                                                                                                                                                    |
| H05 campaigns/drafts                            | PASS local canonical creation/membership, draft reads/review, batch staging/review and gated release tests. Shared purpose-aware contact eligibility is wired. Full content editing and live delivery NOT RUN.                                                                                                                                                                                  |
| H06 mail/receipts                               | PASS mailbox/thread/message, canonical mail-event and activity receipt reads, plus platform-wide quarantine and webhook-receipt reads that only an all-customer connection may call (raw payloads and snapshots never returned). Reply/send workflow is excluded by design: no tool sends mail.                                                                                                 |
| H07 support                                     | PASS local support detail/message reads and internal-note, portal information-request and completion proposals. Real customer communication NOT RUN.                                                                                                                                                                                                                                            |
| H08 onboarding                                  | PASS onboarding dossier read; PASS `customers.propose_onboarding_questions` (grouped, always-ask, atomic, 9 tests); PASS `customers.propose_create` and `customers.propose_invite` against a fake identity provider, each behind its own off-by-default switch and always-ask. NOT RUN: any call to the real identity provider. `venues.propose_source` stays unbuilt (no source model exists). |
| H09 company/reports/billing                     | PASS promoted current tenant context, reports/status, billing status and paginated invoices. Separate read capabilities; no provider identifiers/raw payloads. Billing proposals and financial actions excluded.                                                                                                                                                                                |
| H10 routines/access/offboarding                 | PASS routine, membership and offboarding metadata reads with scoped cursors; private evidence/artifact references withheld. No execution, membership changes, revocation or export creation.                                                                                                                                                                                                    |
| H12 mobile keyboard                             | PASS 12 viewport tests on this continuation; retained local browser log has 8 Chromium/WebKit tests using simulated visualViewport. Probable cause/files/protocol documented. Real iPhone Safari/Chrome NOT RUN; do not claim physical-device repair.                                                                                                                                           |
| H13 CI/release prep                             | PASS staging admission pins advanced to the 255/280 endpoint with the 254/277 predecessor admitted; readiness, maintenance and image approval pins updated; raw-SQL inventory entry added; repository index regenerated; repo-wide `pnpm typecheck` 27/27. A release and rollback proposal exists in `docs/operator/release-proposal-operator-crm-20261001.md` and is NOT approved or executed. |
| H14 portal/navigation                           | PASS clean thinking state, simpler portal, source-brand wordmark, immediate operator tabs and dedicated Stripe Billing tab; local UI tests/typechecks and rendered fixture proof. Real authentication, Stripe actions and physical-device testing NOT RUN. Separate public-rig asset fixture FAIL (blank local asset viewport; shared renderer unchanged).                                      |
| H11                                             | NOT RUN; not built.                                                                                                                                                                                                                                                                                                                                                                             |

## Continuation commits (task order)

1. `2141773c` H06 tenant-linked mailbox and receipt reads.
2. `665e0ef4` H09 company, report and billing reads.
3. `abb59801` H10 routine, access and offboarding reads.
4. H08 question-group integration paused at the user's request; no commit.
5. `3917966d` H14 thinking state, portal, wordmark, navigation and Billing, saved during wrap-up.
6. `d23eba91` pause-point journal.
7. `6a6dddb4` H08 grouped onboarding questions.
8. `e5f07fcf` `support.propose_triage`.
9. `15700d87` `customers.propose_create` and `customers.propose_invite`.
10. `fdc860de` H13 admission pins and raw-SQL inventory; `cddc3ed2` repository index.
11. `0d07b33d` H06 platform mail quarantine and webhook receipt reads.
12. `93a72b24` visitor notices (`venues.list_operational_updates` plus create, go-live and end proposals).
13. `b9190e59` release and rollback proposal and journal refresh; `67d59342` `venues.get_visitor_summary` and lazy identity-provider loading.

Earlier baseline slices include `c082ef02` shared eligibility, `497310c9` H05, `55c3bb67` H12,
`0c01e7c4` H07 and `ca06dcec` onboarding dossier reads.

### Historical foundation commits

`7c2eac83` wording and unrecorded support priority | `2a4162b3` H01 | `2fe307f9` H02.1 | `33dfc31a` H02 | `d1dfd5e3` H03.1 |
`11195b4c` H03.2 | `5fcd2ac8` H03.3 | `a861acfe` H03.4 | `285248f4` H04.1 reads | `eeb05e70` H04.1 writes | (this commit) H04.2.

## Migration (one, unreleased, additive)

`packages/db/prisma/migrations/20261001100000_crm_receipt_and_execution_foundations`

- `prospect_activities.external_receipt_key` (nullable, unique) with a safe backfill of operator-logged sends.
- `operator_proposals`: `apply_started_at`, `lease_expires_at`, `fence_token`, `attempt`, `preview_digest`, `policy_revision`.
- `operator_plans`: `lease_expires_at`, `fence_token`, `attempt`.
- `operator_autonomy_policies.allowed_kinds`; new `operator_policy_state` (singleton revision), `operator_admission_counters`, `operator_armings`.
- Backfill verified on a disposable database seeded with duplicate rows (earliest takes the key; others and non-operator rows untouched).
- NOT applied anywhere except the disposable database (255 migrations, 280 public tables there).
- H13 pins are updated: `scripts/run-staging-migration-predeploy.mjs` (255 / 280, the 254 / 277 `crm-receipt-predecessor`),
  `operational-health.ts`, `Dockerfile.web.staging` approval name, the readiness and maintenance guards and their tests.
  The approval identifier names a target and grants nothing. The approved production cutover record
  (`docs/production-cutover-20260930.md`) covers migrations 253 and 254 only and was left untouched; migration 255 needs a new approval.

## Flag and authority defaults (all unchanged or tighter)

- New switches, all default off and refused at propose time while off: `OPERATOR_CAMPAIGN_RELEASE_ENABLED`,
  `OPERATOR_CUSTOMER_CREATE_ENABLED` (creates an identity-provider organization, emails nobody) and
  `OPERATOR_CUSTOMER_INVITE_ENABLED` (the provider emails a sign-up link). The endpoint stays dark unless `OPERATOR_OAUTH_ENABLED`.
- New proposal kinds are never covered by an old broad AUTO switch. `crm.account-archive`, `crm.duplicate-resolution`,
  `customers.create`, `customers.invite`, `customers.onboarding-questions` and reverts are always-ask. Automatic application spends an hourly budget and degrades to ask.
- No tool sends email, charges, deletes data, or changes policy. Controls (`cancel`, `recover`) cannot approve anything.

## Continuation evidence (local disposable database and synthetic UI fixtures)

### Latest run (Claude, 2026-10-01, HEAD `67d59342`)

- PASS serial operator suite from packages/api: 26 files / 268 tests (`--no-file-parallelism`; parallel runs share one database and
  fail from contention, which is not a product defect). PASS contracts 636 tests (all contract files), tsc for api, contracts, db and config.
- PASS `pnpm typecheck` across the repository: 27/27 tasks (run at `cddc3ed2`).
- PASS full `pnpm test` turbo run at `ee500cb0`: 23 of 27 tasks passed; the single failure was `venue-qr-pdf` timing out at 5 s while the machine
  was under load, and it passes alone (6 tests). Turbo stopped there, so the remaining tasks were run separately: all `scripts/*.test.mjs`
  573 pass, 0 fail, 1 skipped. Dashboard, web and packages ran inside the turbo tasks that passed.
- PASS draft staging runbook written (`docs/operator/staging-runbook-migration-255.md`); NOT RUN.
- PASS `pnpm lint`: 15 tasks; one lint error in `customers.ts` was found and fixed, and the api package then linted clean. One existing warning in `apps/web` (a hook dependency) is not from this work.
- PASS migration and release scripts: staging predeploy 31, handoff manifest 8, readiness 1, maintenance 7, documentation safety 7,
  current-truth 5, all `scripts/*.test.mjs` except two that were then fixed (574 run; the raw-SQL approval and the state document counts).
- PASS verifiers: raw SQL (260 ops), tenant bypasses (461), tenant procedures (117), tenant registry (278 models), public surfaces, AI provider
  and AI budget boundaries, repository index. NOT RUN: client-bundle-secrets (needs pnpm and a build), full `pnpm test`, browser suites.
- Fake-identity-provider proof only for customer creation and invitation; no real provider call was made.

- PASS API and contracts `npx tsc --noEmit` for H06, H09 and H10. No API/contracts edits in H14.
  A new full UI/journal round of API/contracts checks was NOT RUN during the requested five-minute wrap-up.
- PASS contracts `npx vitest run src/operator-mcp.test.ts`: 19 tests; catalog/schema, naming and always-ask checks.
- PASS serial database command from packages/api: `source ../../../tmp/ci-env.sh && npx vitest run src/operator --no-file-parallelism`.
  H06: 20 files/238 tests; H09: 21/242; final continuation: 22/244. No skipped operator suites in these runs.
- PASS new disposable suites beside handlers: H06 mail, H09 company/reports/billing and H10 routines/access.
  H08 prepared question-group tests NOT RUN.
  Fixtures roll back; absence assertions prove cleanup without removing immutable evidence.
- NOT RUN positive-row offboarding artifact proof: creating immutable artifact fixtures requires an operation reservation;
  H10 tests exercise its empty scoped list only. No reservation or lifecycle implementation was added.
- PASS H14 dashboard focused tests: 5 files/46 tests; web chat fixture: 11 tests; both app typechecks.
- PASS H12 viewport unit tests: 12; retained `tmp/pw-keyboard.log`: 8 local Chromium/WebKit tests (emulated viewport only).
- PASS rendered H14 Billing at 390x844, 820x1180, 1024x900, 1440x1000 and thinking at phone/desktop sizes.
  Source-brand light/inverse wordmark hashes match the retained manifest. Delayed local tab fixture proves immediate selection,
  loading replacement, browser back, rapid selection and Escape behavior.
- Logs/screenshots: `C:/Users/tomsc/MachineWorkspaces/torchiko/20260930-operator-program/` (`h06-vitest.log`,
  `h09-vitest.log`, final operator logs and `proofs/h14-proof.md`; rendered PNGs live under `proofs/`).
- Resolved failed attempts: H06 fixture omitted bodyExpiresAt; H09 fixtures used invalid knowledge types and optional IDs;
  H10 fixtures exceeded the routine attempt constraint, attached an error code to a successful evidence outcome, and tried
  to create an immutable export artifact without its operation reservation (that fixture was removed);
  H14 stale test expectation and browser-back pending selection. Corrected and rerun green.
- FAIL separate public-family rig local asset fixture: requested thinking falls back to idle, but SVG viewport is blank due
  unavailable local paths. No shared character renderer change. The actual visitor thinking fixture passes.
- NOT RUN: physical iPhone Safari/Chrome, live authentication/Stripe/provider actions, full repository pnpm test,
  verify:\* gates and migration-pin/release suites. No production-readiness claim.

## Historical foundation evidence (retained; superseded by continuation results)

- PASS `pnpm exec vitest run src/operator --pool=forks --maxWorkers=1` in packages/api with `RUN_OPERATOR_DB_INTEGRATION=1`
  against the disposable database: 16 files passing (unit + disposable-integration + adversarial).
- PASS `vitest run` packages/contracts `src/operator-mcp.test.ts` (catalog parity, schemas, always-ask, no forbidden keys).
- PASS `tsc --noEmit` packages/api, packages/contracts, packages/db; eslint clean on `src/operator`.
- PASS dashboard `app/api/operator` route tests (autonomy now one atomic batch).
- NOT RUN: full `pnpm test`, dashboard typecheck, `verify:*` repo gates, browser/visual suites, scripts migration pins (above).

## Known gaps and decisions needed

- H06 webhook receipts and quarantine have no tenant owner, so they are exposed only as platform-wide reads to a connection that reaches every customer. Tenant-scoped views of them remain impossible without an ownership link.
- Refresh-token response replay (lost response) still revokes the grant; a bounded replay window needs a security review.
- `recoverOperation` is invoked by a tool; an unattended driver (worker or scheduled route) needs an owner decision on activation.
- Raw-SQL inventory: the earlier claim that no raw SQL was added was wrong. H02.1 added one advisory lock (human create-operation key) in `venue-create-action.ts`; H13 approved it in the inventory (260 operations: 152 reads, 108 writes).
- Lossless CRM merge is not built: the canonical rule refuses destructive merges and a reversible merge needs a ledger design.
- Customer account creation calls the real identity provider only when `OPERATOR_CUSTOMER_CREATE_ENABLED=true`; proof used a fake provider. An interrupted provider call leaves the create intent unconfirmed and a person must reconcile it.
- `client-bundle-secrets` verifier needs a built bundle through pnpm: NOT RUN.

## Remaining bounded work

Lossless merge (design first), real-device keyboard proof (`torchiko-keyboard-device-protocol.md`), H11 decision, an unattended
`recoverOperation` driver, refresh-response replay review, and the human steps in the release proposal.

## 2026-10-01 — PR #38 exact-head CI rerun

- Checked head: `6e79b6d451ff052d7db3829dde2e288f549f3017`.
- [Run 36877213043](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/36877213043), attempt 2:
  re-ran all jobs through GitHub's browser UI after attempt 1 hit the 60-minute limit in `pnpm test:scripts`.
- PASS [railway-iac](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/36877213043/job/110491003332),
  19s, directly observed in GitHub.
- PASS [visitor-launch](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/36877213043/job/110491003652),
  19m 22s, directly observed in GitHub.
- PASS [ci](https://github.com/tomschoenekase-dotcom/pathfinder/actions/runs/36877213043/job/110491003859),
  reported by Tom: "railway iac visitor launch and ci are all green". Browser monitoring became unavailable
  before CI finished; the agent did not independently observe its final result.
- [PR #38](https://github.com/tomschoenekase-dotcom/pathfinder/pull/38): its own checks initially showed the same
  two passes and cancelled CI on this head; Tom confirmed all three green after the rerun.
- No source or workflow fix was needed. This continuation changes only this journal; no local test rerun was needed.
- No merge, deployment, live migration, setting/flag change, external communication, or financial action.
- This journal-only commit creates a new head and triggers CI again; the results above apply only to the checked SHA.
  No green-check claim is made for the journal commit. Next: review that head's checks before any separately authorized release.
