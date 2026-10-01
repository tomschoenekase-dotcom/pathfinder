# Torchiko operator program: implementation journal

Handoff: "Torchiko Claude Code Implementation Handoff" (lanes H01-H10, H12-H14 active; H11 decision-needed).
No secrets or real customer content in this file. PASS / FAIL / NOT RUN is recorded with the command and environment.

## Where things stand (update this block first)

- Baseline audited: `06e5745473762a18db07c5d30d0f6677c62c6103` (= `origin/master`, staging, release-b-operator at the start).
- Work branch: `machine/torchiko/20260930-operator-program`, isolated worktree. Nothing else was touched.
- Local proof environment: Windows, Node 24, `pnpm install --frozen-lockfile`, disposable Postgres (`pgvector/pgvector:pg16`,
  container `claude-operator-program-pg`, database `pathfinder_disposable_op`, all 255 migrations applied).
- Never run: production, staging, live providers, real sends, real invitations, billing. Not touched.

| Lane                                                                                | State                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01 truthful contracts / discovery                                                  | DONE for context, tenant/campaign/member discovery, completeness, structured errors, output validation. Remaining: tool-level `deployed/provider/worker` health needs real provider reads (H06/H13).                                                                                                                                                                               |
| H02 canonical transactions / replay                                                 | DONE: inactive venue create + operation-key replay, in-transaction CAS (stage, contact, follow-up, archive), unique namespaced send receipts, monotonic last activity. Remaining: content (knowledge/appearance) revision CAS beyond existing canonical actions.                                                                                                                   |
| H03 durable execution / authority                                                   | DONE: leased fenced claims, phase markers, reconciliation, plan resume, cancel/recover, kind-scoped AUTO + policy revision + atomic batch, preview digest, client revocation, admission counters, atomic refresh rotation, one-use arming. Remaining: worker/cron driver for `recoverOperation` (today a tool), refresh-response replay design (needs security review, NOT built). |
| H04 CRM identity / maintenance                                                      | Increment 1 (resolve, context, contacts, notes, history, upkeep writes) and increment 2 (duplicate review, historical reconciliation case) DONE. Increment 3 (lossless merge) NOT STARTED; duplicate review is explicitly not a merge. Remaining: imports/repair adapters, historical-mail quarantine review reads.                                                                |
| H05 campaigns / drafts                                                              | Discovery reads done (H01). Creation, membership, draft read/update/review, batch preview/freeze NOT STARTED.                                                                                                                                                                                                                                                                      |
| H06 mail threads / shared eligibility                                               | NOT STARTED. Known gap: operator `crm.check_can_contact` accepts UNKNOWN readiness that canonical sending rejects.                                                                                                                                                                                                                                                                 |
| H07 support                                                                         | NOT STARTED.                                                                                                                                                                                                                                                                                                                                                                       |
| H08-H10 customer/content/launch, reports/billing reads, routines/access/offboarding | NOT STARTED.                                                                                                                                                                                                                                                                                                                                                                       |
| H12 mobile keyboard                                                                 | NOT STARTED. Cause, files and Safari/Chrome plan must be stated before editing (see handoff). Real-device proof is a user-supplied gate.                                                                                                                                                                                                                                           |
| H13 CI / release prep                                                               | NOT STARTED. Pinned migration manifest and `EXPECTED_LATEST_MIGRATION` still name 254 (see Migration).                                                                                                                                                                                                                                                                             |
| H14 portal / navigation / billing / admin-MCP polish                                | NOT STARTED.                                                                                                                                                                                                                                                                                                                                                                       |
| H11                                                                                 | Decision needed; not built.                                                                                                                                                                                                                                                                                                                                                        |

## Commits on the branch (oldest first)

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

## Evidence (local, this branch, commit above)

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

## Next runnable step

H05: campaign creation/membership/draft lifecycle on the canonical campaign services, then H06 shared eligibility.
In parallel and independent: H12 (state cause/files/verification plan first), H14 increments.
