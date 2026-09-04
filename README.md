# PathFinderOS

PathFinderOS is a multi-tenant SaaS monorepo for a public guest app, a tenant dashboard that also contains the platform-admin console, a worker process, and shared platform packages managed with pnpm workspaces and Turborepo.

## Workspaces

- `.railway` — isolated Node 22 Railway infrastructure-as-code authoring toolchain
- `apps/dashboard` — tenant dashboard and platform-admin console
- `apps/web` — public guest chat and controlled embeds
- `apps/workers` — background and scheduled jobs
- `packages/ai` — centralized AI provider, admission, and budget boundary
- `packages/analytics` — analytics event contracts and emission
- `packages/api` — tRPC routers and server procedures
- `packages/auth` — Clerk-backed identity helpers
- `packages/billing` — Stripe gateway, billing projections, reconciliation, and access policy
- `packages/config` — runtime configuration, logging, and shared tool configuration
- `packages/contracts` — provider-neutral shared schemas and versioned contracts
- `packages/db` — Prisma client, tenancy middleware, and persistence helpers
- `packages/jobs` — BullMQ queues, payloads, and dispatch policy
- `packages/intake-engine` — source-adapter orchestration, evidence reconciliation, and draft handoff
- `packages/ui` — shared React components and guest-chat theming

The inventory above is checked against every configured workspace manifest by the repository script tests.

## Start here

[`docs/repository-onboarding.md`](docs/repository-onboarding.md) provides the safe 15-minute setup, local-staging, release, current-truth, and debugging path. [`docs/repository-command-index.md`](docs/repository-command-index.md) is generated from the root scripts and documented environment surface so command discovery cannot silently drift.

## Local verification

- `pnpm test` runs the ordinary workspace and script suites. Guarded database and Redis integrations remain opt-in.
- `pnpm test:redis:disposable` requires Docker, publishes a credential-free Redis 7 container on a dynamically assigned loopback port, executes all three BullMQ integration suites, and verifies exact-container removal.
- `pnpm verify:client-bundles` forces a fresh sequential production build with synthetic server-secret canaries and scans every Next application's browser-deliverable output.
- `pnpm repository:index:verify` proves the committed command/configuration index still matches `package.json` and `.env.example` without copying environment values.

## Operator references

- [`docs/venue-package-format.md`](docs/venue-package-format.md) is the authoritative JSON format and safe lifecycle guide for the dashboard venue-package importer. Its examples are checked against the runtime schema in the API test suite.

## Staging job redrive

The preview-first terminal BullMQ redrive procedure is documented in [`docs/terminal-job-redrive.md`](docs/terminal-job-redrive.md). It is deliberately unavailable in production.
