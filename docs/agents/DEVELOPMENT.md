# Torchiko agent development guide

Torchiko's coding-agent entry point is the repository-owned, inspect-first command:

```powershell
pnpm torchiko dev bootstrap --json
pnpm torchiko doctor --json
pnpm torchiko repo map --json
```

The interface reads canonical repository sources. It does not create data, connect to a database, start providers, enable workers, seed an environment, or change deployment state.

## Environment safety

Run `pnpm torchiko doctor --json` before database, worker, evaluation, agent-run, outreach, or billing work. The report:

- identifies local/staging/production intent;
- classifies database targets as `unset`, `loopback`, `external`, or `invalid` without returning credentials, usernames, hosts, or database names;
- verifies that the local Prisma client was generated after dependency installation;
- shows consequential rollout gates as booleans only;
- fails when production identity is ambiguous or production database/scheduler invariants are unsafe;
- treats missing local database configuration as a warning, not permission to invent or copy credentials.

The doctor is evidence about the current process environment only. It is not proof that an external service is healthy or that a migration is applied.

On a fresh worktree, run `pnpm --filter @pathfinder/db db:generate` after installing dependencies. Generation is local code generation; it does not apply or inspect migrations.

## Repository intelligence

`pnpm torchiko repo map --json` returns stable source pointers, application/admin router entry points, worker processors, and counts for tests, migrations, and operational MCP tools. Prefer it for orientation; use repository search for implementation details.

Canonical sources remain:

- `packages/api/src/root.ts` and `packages/api/src/routers/admin/_admin.ts` for typed APIs;
- `packages/db/prisma/schema.prisma` and migrations for persistence;
- `packages/contracts/src/mcp-v0.ts` for the operational MCP contract;
- `packages/api/src/prospect-agent/registry.ts` for CRM read/draft tools;
- `packages/jobs/src` and `apps/workers/src/processors` for asynchronous work;
- `packages/config/src/env.ts` for environment and rollout policy.

## Tool discovery

Run `pnpm torchiko tools list --json`. The command discovers the operational MCP and prospect-agent tools from their canonical registries. It does not imply that a transport, credential, write gate, or provider is enabled.

Run `pnpm verify:agent-tools` before handoff. The coverage gate requires every mounted application/admin router to match exactly one explicit agent/developer coverage decision. Restricted and human-controlled decisions are valid; silent omission is not.

The first-party tRPC application surface is broader than the external agent surface. See `docs/agents/CAPABILITY_MATRIX.md` and `docs/agents/GAP_REPORT.md` before assuming UI/API parity.

## Targeted tests

Use `pnpm torchiko tests find <subsystem> --json` to locate up to 100 related test files. Examples:

```powershell
pnpm torchiko tests find agent-bridge --json
pnpm torchiko tests find operational-update --json
pnpm torchiko tests find billing --json
```

Then run the narrow package test before the broader repository suites. The completion gate remains `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and the security verifiers in `package.json`.

## Fixtures and visual checks

`pnpm torchiko fixtures list --json` lists repository-owned local visual routes and the Golden Venue fixture. Visual fixtures are sanitized, development-only UI states; they are not database lifecycle fixtures.

`pnpm torchiko scenarios validate --json` verifies four explicitly synthetic venue worlds. The time, location, and conversation-replay commands are deterministic and do not touch a database or provider:

```powershell
pnpm torchiko simulate time small-museum 2026-08-24T16:00:00.000Z --json
pnpm torchiko simulate location outdoor-park 41.89 -87.61 --json
pnpm torchiko replay conversation large-museum --json
```

Replay preparation emits a synthetic transcript and required-fact assertions. Provider-backed execution and scoring remain separate, explicitly enabled evaluation operations.

The Golden Venue contract is reused rather than replaced:

```powershell
pnpm torchiko golden validate
```

Seeding or resetting data remains separately guarded. Follow `docs/golden-venue-runbook.md`; never broad-delete a shared database.

## Common workflow

1. Run bootstrap and doctor.
2. Read the repository map and capability matrix.
3. Discover the relevant tool and tests.
4. Confirm environment, tenant, venue, permission, and approval scope.
5. Prefer canonical service/domain actions over direct database writes.
6. Add or update idempotency, audit, tenant-isolation, and structured-error proof with the change.
7. Run targeted tests, related suites, security boundaries, lifecycle checks, and UI validation proportional to the change.

Operational integrations should use the default-dark agent bridge methods `listOperationalTools` and `callOperationalTool`. The bridge derives scope from the verified credential. Do not add client or venue IDs as an independent authority source, and do not enable approval-bound MCP writes until the canonical domain model supports honest machine-actor attribution.

## Deliberate boundaries

- Browser automation is for UI/E2E verification or third parties without a better interface, not normal Torchiko administration.
- Agent capability never grants approval. Draft, proposal, approval, execution, and publication remain separate states.
- Prospect outreach agents cannot approve or send messages.
- Billing agent tools can propose, not mutate Stripe or customer access.
- Production credentials and provider enablement are owner-controlled and are never printed by developer tooling.
