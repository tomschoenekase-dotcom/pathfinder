# Repository onboarding

This is the shortest safe route from a fresh checkout to useful Torchiko engineering. It does not authorize staging/production changes, credentials, customer contact, or billing.

## Fifteen-minute local path

Prerequisites: Node.js 20.19 or newer, pnpm 9 (the repository pins 9.15.4), Git, and Docker Desktop only when using disposable/local-staging workflows.

1. Install exactly from the lockfile: `pnpm install --frozen-lockfile`.
2. Run the fast deterministic baseline: `pnpm typecheck`, `pnpm lint`, then `pnpm test:scripts`.
3. Inspect the complete generated command/configuration inventory: [`repository-command-index.md`](repository-command-index.md).
4. For a provider-dark realistic stack on Windows, run `pnpm local-staging:up`. It creates a named disposable PostgreSQL database plus Redis, MinIO, and ClamAV, applies migrations through the guarded disposable runner, and starts web/dashboard/workers with outbound providers disabled.
5. Inspect it with `pnpm local-staging:status`; stop application processes and containers with `pnpm local-staging:stop`. State is preserved under the location reported by the command.

The dependency images are content-addressed. Follow
[`local-staging-infrastructure.md`](local-staging-infrastructure.md) to upgrade them; never replace
the checked-in digests with mutable tags during troubleshooting.

Do not copy credentials into tracked files. `.env.example` documents names and default-dark posture, while `packages/config/src/env.ts` and its tests are the runtime authority. Ordinary unit/script verification supplies synthetic safe configuration; use real credentials only through an approved external environment.

## Release path

- `pnpm verify:release` is the quick static preflight.
- `pnpm verify:release --profile candidate` is the clean-worktree local release candidate and includes typecheck, lint, tests, builds, browser checks, accessibility, and client-bundle secret scanning.
- `pnpm staging:handoff --base-ref <owner-staging-ref> --candidate <40-char-sha> --release-report <candidate-report>` creates a deterministic owner-review manifest; it does not deploy.
- [`release-verification.md`](release-verification.md), [`staging-release-workflow.md`](staging-release-workflow.md), and [`railway-staging.md`](railway-staging.md) define the full boundaries.

## Current truth map

Use these before historical packets or implementation plans:

- [`system-state/TORCHIKO_STATE_OF_SYSTEM.md`](system-state/TORCHIKO_STATE_OF_SYSTEM.md) — observed system state and limitations.
- [`system-state/TORCHIKO_CAPABILITY_MATRIX.md`](system-state/TORCHIKO_CAPABILITY_MATRIX.md) — implemented versus proven capabilities.
- [`system-state/TORCHIKO_AUDIT_BACKLOG.md`](system-state/TORCHIKO_AUDIT_BACKLOG.md) — reconciled prioritized gaps.
- [`system-state/TORCHIKO_ENGINEERING_HANDOFF.md`](system-state/TORCHIKO_ENGINEERING_HANDOFF.md) — engineering handoff and validation context.
- [`founder-decision-packet-import.md`](founder-decision-packet-import.md) — imported August 22 founder authority and retained gates.

Files named packet, plan, sprint, review, or execution status may be valuable history, but they are not automatically current. Reconcile their date and implementation evidence against the current-truth map before acting.

## Debug routing

- Environment admission: `packages/config/src/env.ts` and `pnpm --filter @pathfinder/config test`.
- Schema/migrations: `packages/db/prisma`, `pnpm db:migrate:disposable`, and [`database-incident-stop.md`](database-incident-stop.md).
- Public/tenant boundaries: `pnpm verify:public-surfaces`, `pnpm verify:tenant-procedures`, and `pnpm verify:tenant-bypasses`.
- Agent surface: `pnpm doctor`, `pnpm verify:agent-tools`, and [`agents/CAPABILITY_MATRIX.md`](agents/CAPABILITY_MATRIX.md).
- Hosted staging identity/readiness: [`operations-readiness.md`](operations-readiness.md) and [`staging-release-workflow.md`](staging-release-workflow.md).
