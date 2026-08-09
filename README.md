# PathFinderOS

PathFinderOS is a multi-tenant SaaS monorepo for a public guest app, a tenant dashboard that also contains the platform-admin console, a worker process, and shared platform packages managed with pnpm workspaces and Turborepo.

## Workspaces

- `apps/dashboard` — tenant dashboard and platform-admin console
- `apps/web` — public guest chat and controlled embeds
- `apps/workers` — background and scheduled jobs
- `packages/ai` — centralized AI provider, admission, and budget boundary
- `packages/analytics` — analytics event contracts and emission
- `packages/api` — tRPC routers and server procedures
- `packages/auth` — Clerk-backed identity helpers
- `packages/config` — runtime configuration, logging, and shared tool configuration
- `packages/contracts` — provider-neutral shared schemas and versioned contracts
- `packages/db` — Prisma client, tenancy middleware, and persistence helpers
- `packages/jobs` — BullMQ queues, payloads, and dispatch policy
- `packages/ui` — shared React components and guest-chat theming

The inventory above is checked against every `apps/*/package.json` and `packages/*/package.json` by the repository script tests.

## Local verification

- `pnpm test` runs the ordinary workspace and script suites. Guarded database and Redis integrations remain opt-in.
- `pnpm test:redis:disposable` requires Docker, publishes a credential-free Redis 7 container on a dynamically assigned loopback port, executes all three BullMQ integration suites, and verifies exact-container removal.
- `pnpm verify:client-bundles` forces a fresh sequential production build with synthetic server-secret canaries and scans every Next application's browser-deliverable output.

## Operator references

- [`docs/venue-package-format.md`](docs/venue-package-format.md) is the authoritative JSON format and safe lifecycle guide for the dashboard venue-package importer. Its examples are checked against the runtime schema in the API test suite.

## Staging job redrive

The preview-first terminal BullMQ redrive procedure is documented in [`docs/terminal-job-redrive.md`](docs/terminal-job-redrive.md). It is deliberately unavailable in production.
