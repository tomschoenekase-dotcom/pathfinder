# Torchiko operator program: implementation journal

Handoff: "Torchiko Claude Code Implementation Handoff" (lanes H01-H10, H12-H14 active; H11 decision-needed).
No secrets or real customer content in this file. PASS / FAIL / NOT RUN is recorded with commit and command.

## Checkpoint 0 (2026-09-30)

- Audited baseline: `06e5745473762a18db07c5d30d0f6677c62c6103`. At checkpoint 0 it equals `origin/master`,
  `origin/codex/pathfinder-v2-staging` and `origin/codex/torchiko-release-b-operator`: no drift.
- Work branch: `machine/torchiko/20260930-operator-program`, isolated worktree created from the baseline by the
  vault's `machine_workspace.py` (nothing else was touched; no other checkout was modified).
- Existing unmerged side branches (not merged here): `claude/torchiko-operator-{admin-ui,adversarial,kinds,reads}`.
  `claude/torchiko-safari-keyboard` (574fb5e1, "Fix iPhone Safari keyboard...") IS already in the baseline, so it is
  the "latest keyboard fix" the H12 brief describes.
- Local setup: `pnpm install --frozen-lockfile`, `prisma generate` (packages/db). Disposable DB suites need Docker/Postgres.

## Lane status

| Lane             | State                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| H01              | Increment 1 done (below). Increments 2-3 (context/discovery, pagination/plan rediscovery) next. |
| H02-H10, H12-H14 | Not started.                                                                                    |
| H11              | Decision needed; not built.                                                                     |

## H01 increment 1: truthful wording and contract parity

Changed (no schema/migration, no flag, no new authority):

- `docs/operator/manual.md` + `packages/api/src/operator/tools/manual-text.ts` (kept equal by an existing test):
  `FAILED` no longer says "it did not happen"; plans are stated non-atomic with partial application possible;
  publish is availability only; readiness `ready` meaning; support priority `null` means not recorded.
- `packages/contracts/src/operator-mcp.ts`: `venues.propose_publish` and `operator.propose_plan` descriptions;
  `support.list` `priority` is nullable (was a fabricated `NORMAL`). Backward compatible for readers that tolerate null.
- `packages/api/src/operator/tools/support.ts`: returns `priority: null`.
- Tests: `packages/contracts/src/operator-mcp.test.ts` (2 new).

Evidence (commit: see git log, branch above; env: local Windows, Node 24.12, no DB):

- PASS `pnpm exec vitest run src/operator-mcp.test.ts` in packages/contracts: 19/19.
- PASS `tsc --noEmit` in packages/api and packages/contracts; eslint clean on `src/operator/tools`.
- PASS `vitest run src/operator` in packages/api: 81 passed.
- NOT RUN: 79 tests in four `*.disposable.integration/adversarial` suites (skipped without a disposable Postgres).
  Requirement: the repo's disposable-database runner (Docker).

## Next runnable step

H01 increment 2: scope-aware `operator.get_context` (effective capabilities with implemented/deployed/enabled/
authorized/provider/worker/last-verified), then account/tenant/venue/campaign identifier discovery. Then H02.
