# PathFinderOS

PathFinderOS is a multi-tenant SaaS monorepo for a public web app, tenant dashboard, admin console, worker process, and shared platform packages managed with pnpm workspaces and Turborepo.

## Workspaces

- `apps/web`
- `apps/dashboard`
- `apps/admin`
- `apps/workers`
- `packages/db`
- `packages/api`
- `packages/auth`
- `packages/ui`
- `packages/jobs`
- `packages/analytics`
- `packages/config`

## Local verification

- `pnpm test` runs the ordinary workspace and script suites. Guarded database and Redis integrations remain opt-in.
- `pnpm test:redis:disposable` requires Docker, publishes a credential-free Redis 7 container on a dynamically assigned loopback port, executes all three BullMQ integration suites, and verifies exact-container removal.
- `pnpm verify:client-bundles` forces a fresh sequential production build with synthetic server-secret canaries and scans every Next application's browser-deliverable output.

## Staging job redrive

The preview-first terminal BullMQ redrive procedure is documented in [`docs/terminal-job-redrive.md`](docs/terminal-job-redrive.md). It is deliberately unavailable in production.
