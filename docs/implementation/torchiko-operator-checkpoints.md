# Torchiko operator program: implementation journal

Handoff: "Torchiko Claude Code Implementation Handoff" (lanes H01-H10, H12-H14 active; H11 decision-needed).
No secrets or real customer content in this file. PASS / FAIL / NOT RUN is recorded with the command and environment.

## Where things stand (update this block first)

- Baseline audited: `06e5745473762a18db07c5d30d0f6677c62c6103` (= `origin/master`, staging, release-b-operator at the start).
- Work branch: `machine/torchiko/20260930-operator-program`, isolated worktree. Nothing else was touched.
- Local proof environment: Windows, Node 24, `pnpm install --frozen-lockfile`, disposable Postgres (`pgvector/pgvector:pg16`,
  container `claude-operator-program-pg`, database `pathfinder_disposable_op`, all 255 migrations applied).
- Continuation baseline: `ca06dcec`; local-only tasks completed in order on 2026-10-01.
- Never run: production/staging deployment, live migration/provider action, real customer communication, account creation,
  new credentials, paid API use or money movement. H11, H13 and lossless merge remain excluded.

| Lane                                            | Current state and proof limits                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01-H03 contracts, canonical actions, execution | Earlier local slices implemented and covered by the operator suite. Provider health, unattended recovery and refresh-response replay remain gaps. No activation or release claim.                                                                                                                                                                          |
| H04 CRM                                         | Earlier identity/maintenance and duplicate review slices implemented. Lossless merge untouched and excluded.                                                                                                                                                                                                                                               |
| H05 campaigns/drafts                            | PASS local canonical creation/membership, draft reads/review, batch staging/review and gated release tests. Shared purpose-aware contact eligibility is wired. Full content editing and live delivery NOT RUN.                                                                                                                                             |
| H06 mail/receipts                               | PASS mailbox/thread/message, canonical mail-event receipts and activity receipt reads; scoped pagination, untrusted prose and rollback proof. FAIL complete receipt/quarantine coverage: raw webhook receipts and quarantine have no authoritative tenant ownership link (blocker below).                                                                  |
| H07 support                                     | PASS local support detail/message reads and internal-note, portal information-request and completion proposals. Real customer communication NOT RUN.                                                                                                                                                                                                       |
| H08 onboarding                                  | PASS earlier canonical dossier reads. NOT RUN question-group proposal: handler, catalog integration script and 9 disposable tests prepared outside worktree, not integrated/typechecked/executed. Customer creation and wider content/launch work excluded.                                                                                                |
| H09 company/reports/billing                     | PASS promoted current tenant context, reports/status, billing status and paginated invoices. Separate read capabilities; no provider identifiers/raw payloads. Billing proposals and financial actions excluded.                                                                                                                                           |
| H10 routines/access/offboarding                 | PASS routine, membership and offboarding metadata reads with scoped cursors; private evidence/artifact references withheld. No execution, membership changes, revocation or export creation.                                                                                                                                                               |
| H12 mobile keyboard                             | PASS 12 viewport tests on this continuation; retained local browser log has 8 Chromium/WebKit tests using simulated visualViewport. Probable cause/files/protocol documented. Real iPhone Safari/Chrome NOT RUN; do not claim physical-device repair.                                                                                                      |
| H13 CI/release prep                             | NOT RUN and untouched. Migration pins, approval/release packet and deployment excluded.                                                                                                                                                                                                                                                                    |
| H14 portal/navigation                           | PASS clean thinking state, simpler portal, source-brand wordmark, immediate operator tabs and dedicated Stripe Billing tab; local UI tests/typechecks and rendered fixture proof. Real authentication, Stripe actions and physical-device testing NOT RUN. Separate public-rig asset fixture FAIL (blank local asset viewport; shared renderer unchanged). |
| H11                                             | NOT RUN; not built.                                                                                                                                                                                                                                                                                                                                        |

## Continuation commits (task order)

1. `2141773c` H06 tenant-linked mailbox and receipt reads.
2. `665e0ef4` H09 company, report and billing reads.
3. `abb59801` H10 routine, access and offboarding reads.
4. H08 question-group integration paused at the user's request; no commit.
5. `3917966d` H14 thinking state, portal, wordmark, navigation and Billing, saved during wrap-up.
6. This pause-point journal refresh.

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
- NOT applied anywhere except the disposable database. Release work (H13) must: update `scripts/run-staging-migration-predeploy.mjs`
  (`finalMigration`, counts), `packages/db/src/helpers/operational-health.ts` `EXPECTED_LATEST_MIGRATION`, the
  admission evidence/approval docs, and obtain a fresh migration approval. The existing admission approval names 254 migrations.
  Until then `scripts/*migration*` tests that pin 254 are expected to fail on this branch (NOT RUN, not claimed green).

## Flag and authority defaults (all unchanged or tighter)

- No new feature flag was added; the operator endpoint stays dark unless `OPERATOR_OAUTH_ENABLED` (existing).
- New proposal kinds are never covered by an old broad AUTO switch. `crm.account-archive`, `crm.duplicate-resolution`,
  `customers.invite` and reverts are always-ask. Automatic application spends an hourly budget and degrades to ask.
- No tool sends email, charges, deletes data, or changes policy. Controls (`cancel`, `recover`) cannot approve anything.

## Continuation evidence (local disposable database and synthetic UI fixtures)

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

- H06 receipt/quarantine reads: `ProspectEmailWebhookReceipt` and `ProspectInboundQuarantine` have no tenant-owned relation; receipt payloads are raw JSON and quarantine candidate thread IDs are an array. Tenant-scoping them through a mailbox could expose another tenant's messages. No migration or raw SQL was added. Current H06 reads use canonical message events and tenant-linked `ProspectActivity.externalReceiptKey`; webhook receipts and quarantine reads remain blocked pending an authoritative tenant ownership link.
- Refresh-token response replay (lost response) still revokes the grant; a bounded replay window needs a security review.
- `recoverOperation` is invoked by a tool; an unattended driver (worker or scheduled route) needs an owner decision on activation.
- Raw-SQL inventory (`scripts/verify-raw-sql-boundary.mjs`): no raw SQL was added.

## Remaining bounded work

H06 raw webhook/quarantine reads need an authoritative tenant ownership link before implementation; no table was added.
H12 physical-device verification remains governed by `torchiko-keyboard-device-protocol.md`.
H13, H11, customer creation and lossless merge are intentionally untouched by this continuation.

## Exact pause point for Claude Code

The user requested a pause/wrap-up so Claude Code can continue overnight. H08 question-group work is prepared only under
`C:/Users/tomsc/MachineWorkspaces/torchiko/20260930-operator-program/tmp/`: `add_h08_questions.py`,
`onboarding-questions.ts`, and `onboarding-questions.disposable.integration.test.ts`.
Read these before running the script; it adds contracts, always-ask registration, the proposal kind and manual prose.
Then run `python tmp/sync_manual.py` from the program root, typecheck API/contracts, run contracts tests,
and run the disposable operator suite serially. Fix/verify and commit H08 separately.
The staged design reuses canonical actions in one group transaction, hashes question revisions, derives child receipt IDs
from globally unique proposal IDs, rechecks membership and records expiry through the canonical refusal path.
These are code-review findings, not executed proof. Existing H14 copy describes this upcoming proposal category;
the actual question-group tool is not in the catalog until H08 is integrated.
