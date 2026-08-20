# Torchiko Engineering Handoff

> **Migration instruction status: STAGING-ONLY AUTHORIZED — PRODUCTION COMMANDS REMAIN STOPPED.**

**Purpose:** give a future coding agent enough verified context to work safely without rediscovering the repository. Read `TORCHIKO_STATE_OF_SYSTEM.md` for product conclusions and `TORCHIKO_CAPABILITY_MATRIX.md` before claiming a feature exists.

**Snapshot:** 2026-08-19 · repo `C:\Users\tomsc\Downloads\PathFinder` · branch `codex/torchiko-cloud-staging-20260819` · HEAD `4cbf8a677d0b4f8f4dc76e935ea0d00d6dcf0b8b` plus a large pre-existing dirty working tree.

## Start here

1. Run `git status --short` before editing. The audited tree contains user-owned tracked changes and untracked launch-capability files. Never reset, checkout, clean, or overwrite them.
2. Read this file, then the capability matrix and state report.
3. Read the actual entry point for the system you will modify; packet/status documents may describe an older generation.
4. Keep tenant scope, audit actors, idempotency, leases, immutable evidence, and budget admission intact.
5. Run the narrow package tests while iterating, then the relevant root gates below.

## Product and architecture boundaries

- **Torchiko** is the umbrella/customer product name. It is not a separate package.
- **PathFinder** is the current repository and venue-focused application layer.
- **PathFinder OS** is the internal/admin surface within the dashboard.
- **Tochi** is the guest/client character and assistant behavior/presentation system.
- **Hermes** is one supported external agent-bridge command/provider. Its runtime, memory, and model are not owned here.

The application is a pnpm/Turborepo monorepo on Node 20+, TypeScript, Next.js 15, tRPC, Prisma/PostgreSQL/pgvector, BullMQ/Redis, S3-compatible storage, Clerk, Anthropic, OpenAI, Resend and Sentry.

```text
apps/
  web/         Public marketing, venue routes, chat, embed/widget, health
  dashboard/   Clerk-authenticated client portal and platform-admin OS
  workers/     Queue processors, schedulers, recovery, provider-backed work
packages/
  ai/          Gateway, registries, budgets, usage, capability routing, voice
  analytics/   Analytics event contracts/helpers
  api/         tRPC routers, authorization, admin modules, MCP/bridge actions
  auth/        Clerk server/auth helpers
  config/      Validated environment and feature flags
  contracts/   Shared Zod/domain contracts
  db/          Prisma schema/migrations, tenant middleware, domain actions
  intake-engine/ Deterministic intake source/proposal orchestration
  jobs/        BullMQ queue names/options/contracts
  ui/          Shared UI primitives
scripts/       Static gates, local staging, migrations, backup, CI helpers
docs/          Architecture, historical packets, and this canonical snapshot
```

## Runtime data flow

1. Public web and dashboard call tRPC/API handlers in `packages/api`.
2. API context derives Clerk user/org/platform role and an optional platform-admin tenant override.
3. Procedures validate input and authorization, then call auditable DB domain helpers rather than performing arbitrary Prisma writes.
4. Immediate public operations may call the centralized AI/embedding/realtime layers in `packages/ai`; long operations enqueue BullMQ jobs.
5. `apps/workers/src/index.ts` registers processors, queues and feature-gated schedulers. Processors use leases/heartbeat/idempotent actions and persist job/usage/audit state.
6. PostgreSQL is the source of truth; pgvector supports semantic search. S3/MinIO stores uploads, Redis coordinates queues/rate limits, ClamAV quarantines media.

## Canonical entry points by system

### Public guest experience

- Page shell: `apps/web/app/[venueSlug]/page.tsx`, `apps/web/app/[venueSlug]/chat/page.tsx`
- Embed: `apps/web/app/embed/[venueSlug]/page.tsx`, `apps/web/lib/widget-origin-policy.ts`
- Main client state: `apps/web/components/VenueChatExperience.tsx`
- Rendering: `apps/web/components/ChatWindow.tsx`, `MessageBubble.tsx`, `ResponseRenderer.tsx`, `VenueChatShell.tsx`
- Contracts: `packages/contracts/src/guest-response.ts`
- API path: `packages/api/src/routers/chat.ts`
- Context/retrieval: `packages/api/src/lib/venue-context.ts`, `packages/db/src/helpers/semantic-search.ts`
- Turn reliability: `packages/db/src/helpers/guest-chat-turn-actions.ts`
- Voice/location/feedback: `packages/api/src/routers/{voice,location,feedback}.ts`, `packages/ai/src/realtime-voice.ts`
- Public surface allowlist: `packages/api/src/testing/public-surface-manifest.json`

### Client portal

- Routes: `apps/dashboard/app/(app)`
- Home: `apps/dashboard/components/DashboardOverview.tsx`
- Remote onboarding: `RemoteOnboardingJourney.tsx`, `IntakeFileUpload.tsx`, `packages/api/src/routers/portal.ts`, `portal-onboarding.ts`, `intake-upload.ts`
- Support: `SupportWorkspace.tsx`, `packages/api/src/routers/support.ts`
- Weekly reports: `(app)/weekly-reports`, `WeeklyReportContent.tsx`
- Access/redirect contract: `apps/dashboard/app/(app)/legacy-route-boundary.test.ts`

Do not assume old client URLs expose full analytics/content editing. Several deliberately redirect to the simplified portal home. Full operational tooling belongs to platform admins.

### Admin operating system

- Route tree: `apps/dashboard/app/(admin)/admin`
- Admin composition: `packages/api/src/routers/admin/_admin.ts`
- Layout/navigation: `AdminSectionShell.tsx`, `ClientWorkspaceShell.tsx`, `AdminCommandPalette.tsx`
- Command/attention center: `packages/api/src/routers/admin/attention-console.ts`, `OperationsAttentionConsole.tsx`
- Content/intake/media/packages/releases/evaluations/agents/support each have a page group, focused component, and focused admin-router module. Navigate from the venue workspace instead of guessing an old route.
- Admin identity and tenant override: `apps/dashboard/lib/admin-caller.ts`, `middleware-access.ts`, impersonate API and API context.

### Knowledge, intake and deployment

There are two active generations. Do not copy the legacy one for new generalized capability, and do not delete it because guest retrieval still depends on it.

- Legacy: Prisma `Place`/`VenueKnowledgeEntry`, `packages/api/src/routers/{place,knowledge}.ts`, admin `legacy-content.ts`, `packages/db/src/helpers/legacy-content-actions.ts`.
- Native: content module identity/revision/publication and typed subtype models in `schema.prisma`; content history/admin routers and DB actions.
- Intake/upload: `packages/api/src/routers/intake*.ts`, `packages/intake-engine`, storage helpers, `apps/workers/src/processors/media-ingestion.ts`.
- Package/manifest: `packages/api/src/routers/venue-package.ts`, `packages/api/src/lib/venue-package-*`, contracts in `packages/contracts`.
- Native release/deployment: admin native-release modules, DB deployment helpers and migrations around `20260812001400` onward.
- Evaluation evidence is attached to frozen content/package snapshots; do not fabricate it from current mutable state.

### AI and model routing

- Text provider/gateway: `packages/ai/src/anthropic.ts`
- Model definitions/pricing: `model-registry.ts`; embeddings: `embedding-model-registry.ts`
- Budget admission/reservations: `budget.ts` and DB AI budget helpers
- Workload configuration: `workload-configuration.ts`, DB actions/admin config
- New capability routing: `capability-routing.ts`, `routed-generation.ts`
- Voice: `realtime-voice.ts`
- Usage persistence: API/worker `ai-usage` helpers plus `AiUsageEvent`/daily rollups
- Static provider boundary: `scripts/verify-ai-provider-boundary.mjs`

All provider calls must stay behind registered gateway boundaries and carry tenant/venue/workload metadata plus budget admission. Do not import provider SDKs directly into arbitrary routes or components.

Current caveat: `apps/workers/src/processors/agent-run.ts` checks an identity provider to choose direct Anthropic vs bridge, but direct execution uses `AI_MODEL_KEYS.AGENT_RUN`. The identity’s stored `modelName` is not itself the model selection input.

### Agents and human-in-the-loop

- Schema: search `AgentIdentity`, `AgentRun`, `AgentAction`, `AgentQuestion`, `AgentApproval`, `AgentMessage`, `AgentOutcomeObservation` in `packages/db/prisma/schema.prisma`.
- Direct worker: `apps/workers/src/processors/agent-run.ts`
- External bridge: `apps/workers/src/lib/agent-bridge-runner.ts`; dashboard bridge API; machine credentials.
- MCP tools/resources: `packages/api/src/mcp`
- DB lifecycle: `packages/db/src/helpers/agent-*`
- Admin routers/components: `packages/api/src/routers/admin/agent-*`; `apps/dashboard/components/admin/Agent*`

Direct provider mode is text-only. Tool use and specialist delegation require the separate bridge. Writes are not generally enabled. Outcome observations are passive evidence; there is no automatic learning or prompt mutation.

### Events, quality, analytics and reports

- Operational events: `packages/db/src/helpers/operational-events.ts`, event models, admin attention console.
- Producers currently include chat, voice, evaluation regression and knowledge proposals.
- `OperationalEventDelivery` is schema ahead of runtime; no multichannel dispatcher exists.
- Evaluations: contracts in `packages/contracts/src/evaluation.ts`; DB helpers; admin evaluation modules; `apps/workers/src/processors/evaluation-run.ts` and dispatch.
- Analytics: `packages/analytics`, `packages/api/src/routers/analytics.ts`, daily rollup/answer analysis/enrichment processors.
- Reports: report configuration/lifecycle in API/DB; `weekly-report.ts`, `weekly-digest.ts`; client sees only published reports.

### Auth, tenancy and public APIs

- Clerk/context: `packages/auth/src/server.ts`, `packages/api/src/context.ts`
- Procedure boundaries: `packages/api/src/trpc.ts`
- Dashboard access: `apps/dashboard/lib/middleware-access.ts`
- Prisma tenant enforcement: `packages/db/src/middleware/tenant-isolation.ts`
- Tenant model registry: `packages/db/src/tenanted-tables.ts`
- Bypass/raw-SQL/tenant verification: `scripts/verify-tenant-*`, `verify-raw-sql-boundary.mjs`
- Public surface manifest/verifier: `packages/api/src/testing/public-surface-manifest.json`, `scripts/verify-public-surface-boundary.mjs`

UI hiding never replaces a backend procedure boundary. Every tenant-owned lookup must constrain tenant and subordinate owner IDs. Approved `withTenantIsolationBypass` calls must identify a stable caller and remain within the static budget. Raw SQL must carry explicit tenant predicates and pass its executable gate. There is no database RLS.

## Database and migration conventions

- Prisma source: `packages/db/prisma/schema.prisma`.
- Migrations are forward-only timestamped directories under `packages/db/prisma/migrations`.
- Current verifier classifies 124 models: 113 tenanted, nine platform, two shared. Update the registry and isolation tests with every model.
- Prefer domain action helpers that validate actor, ownership, lifecycle and audit rows. Avoid direct mutable Prisma writes for protected domains.
- Immutable revision/manifest/evaluation/deployment records are evidence. Corrections create new versions or explicit terminal transitions.
- Composite tenant/venue ownership is intentional. Preserve constraints in schema and raw SQL.
- Use disposable migration tooling first: `pnpm db:migrate:disposable` and the CI disposable database pattern.
- `pnpm db:migrate:staging` is an environment-changing action. Do not run it without explicit staging scope and a backup/recovery check.
- Never edit an applied historical migration to “clean it up.” Add a forward migration.

At audit time, untracked migrations `20260819140000` through `20260819155000` are part of the dirty working tree and must be reviewed as one integration tranche before staging.

## Queues, schedulers and reliability conventions

- Queue constants/defaults: `packages/jobs/src/queues.ts`.
- Worker bootstrap and scheduler registration: `apps/workers/src/index.ts`.
- Processors: `apps/workers/src/processors` (agent, analytics, answer analysis, rollups, embeddings, evaluation, generation recovery/dispatch, media, email, reports).
- Use stable job IDs, persisted dispatch/job records, bounded attempts, leases, heartbeat, cancellation and idempotent terminal actions.
- Schedulers are controlled by `WORKER_SCHEDULERS_ENABLED` and subsystem flags. Scheduled fanout enumerates tenants and records failures.
- Terminal redrive/media admission/disposable Redis gates exist. Do not replace durable state with “fire and forget.”

Local staging during this audit intentionally ran workers in `provider-disabled-health-only` mode. A queued job is not evidence that provider execution works.

## Commands

Run from `C:\Users\tomsc\Downloads\PathFinder` with the pinned pnpm version (`packageManager: pnpm@9.15.4`) and Node `>=20.19`.

### Everyday

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### Focused workspace

```powershell
pnpm --filter @pathfinder/api test
pnpm --filter @pathfinder/db test
pnpm --filter @pathfinder/web test
pnpm --filter @pathfinder/dashboard test
pnpm --filter @pathfinder/workers test
```

### Static safety gates

```powershell
pnpm verify:ai-boundary
pnpm verify:ai-budget
pnpm verify:raw-sql
pnpm verify:tenant-bypasses
pnpm verify:tenant-procedures
pnpm verify:tenant-registry
pnpm verify:public-surfaces
pnpm verify:client-bundles
pnpm verify:docker-context
pnpm verify:staging
pnpm characters:verify
```

### UI contracts

```powershell
pnpm test:accessibility
pnpm test:browser-foundation
```

### Local staging

```powershell
pnpm local-staging:up
pnpm local-staging:status
pnpm local-staging:stop
```

Default URLs are commonly web `http://localhost:3100` and dashboard `http://localhost:3101`, but trust status output. `/api/health` currently proves only database and queue connectivity. Do not inspect or print `.env.local` values.

### Integration/deployment checks

```powershell
pnpm db:migrate:disposable
pnpm test:redis:disposable
pnpm test:redis:terminal-redrive
pnpm test:redis:media-admission
pnpm verify:staging-health
pnpm verify:staging-widget
```

Some commands require Docker or explicit environment URLs/credentials. Do not substitute production for a missing disposable target.

## Test expectations and current baseline

On 2026-08-19 the current dirty tree produced:

- `pnpm test`: 3,926 package tests passed plus 164 script tests; 147 package tests and one script test skipped by environment/gating.
- `pnpm typecheck`: 23/23 tasks passed.
- `pnpm lint`: passed with one raw-`<img>` warning in `apps/web/components/PlaceCard.tsx:70`.
- `pnpm build`: 13/13 workspaces passed; known Sentry/OpenTelemetry dynamic-require and Windows standalone-link warnings.
- all listed static gates, accessibility contracts (7 tests) and browser-foundation contracts (186 tests) passed.

The default suite is not equivalent to CI’s disposable service integrations. Before changing tenancy, migrations, Redis job behavior, storage/uploads, or public surfaces, run the corresponding integration/static gate. Before declaring a provider feature complete, execute a spend-bounded provider-enabled staging smoke.

## Deployment architecture

- Local: Docker PostgreSQL/pgvector, Redis, MinIO, ClamAV; local-staging script starts web/dashboard/worker.
- Hosted code target: Railway, with separate web/dashboard/worker service configurations and Docker builds.
- Database: Supabase PostgreSQL/pgvector.
- Storage: S3-compatible endpoint/bucket.
- Auth: Clerk; dashboard webhook provisions/synchronizes tenant records.
- Text AI: Anthropic; embeddings and realtime voice: OpenAI.
- Email: Resend, currently welcome email only.
- Observability: Sentry and structured persistent logs/audit/job records.

Do not assume these services are currently deployed or correctly secreted because configs exist. The audit did not inspect the external environment. The root Railway/Nixpacks file may be legacy relative to service-specific Docker configs; confirm before deletion. Local compose has floating MinIO/ClamAV tags.

## Major footguns

1. **Dirty tree:** launch-capability work predates this audit. Preserve it and distinguish HEAD from working-tree behavior in every report/PR.
2. **Legacy/native content:** semantic search still reads legacy tables. New native schema does not mean legacy can be deleted.
3. **Schema implies too much:** citations, event delivery, agent outcomes, billing visibility and location records are not proof of end-to-end behavior.
4. **Tenant bypasses:** approved bypass helpers are not permission to omit explicit scope. The static budgets are safety controls.
5. **Raw SQL:** PostgreSQL-specific lifecycle and vector operations are intentional, but every query must be tenant-bounded and included in verification.
6. **Provider calls:** route through `packages/ai`, reserve budget, persist sanitized usage, and never expose raw provider errors/prompts to guests/logs.
7. **Agent model configuration:** identity `modelName` and actual direct registry model currently diverge.
8. **Agent tools:** direct Anthropic runs are text-only. Tool/delegation claims require a live bridge.
9. **Events:** in-app event persistence works; multichannel delivery does not.
10. **Retention:** offboarding export is not deletion. No general retention executor exists.
11. **Health:** HTTP 200 currently means DB + Redis only, not a healthy worker/provider/storage/email system.
12. **Client routes:** many old authoring/analytics URLs intentionally redirect. Do not “restore” them without a product decision.
13. **Fixture routes:** they appear in production build route lists but contain development guards; retain the guards or exclude routes entirely.
14. **Marketing privacy:** `/privacy` is linked and missing.
15. **Character assets:** only `tochi-dev-v0@0-development` passed the asset gate; placeholders cannot be publishable.

## Things not to assume

- A documentation packet marked complete is not current runtime evidence.
- A migration directory means it has been applied to staging/production.
- A green local build means live Anthropic/OpenAI/Resend/S3/Clerk behavior works.
- A queued agent/evaluation/report job means a provider worker processed it.
- Agent outcome records constitute learning.
- The client has the same operational tools as the admin.
- “Billing” fields mean payments/invoicing exists.
- Multilingual UI means translations have been quality-assured.
- Location V1 means maps or routing exists.
- Structured citation blocks mean answers include verified citations.
- Existing backup scripts mean current provider backups/PITR are enabled.
- UI route hiding is authorization; verify the API procedure.

## Legacy areas to avoid copying

- New content types should use native content identity/revision/provenance patterns, not new free-form `VenueKnowledgeEntry` variants.
- New deployment state should use manifests/native release evidence, not ad hoc mutation of venue fields.
- Do not extend the legacy client authoring pages just because route files exist; follow the simple portal/proposal model.
- Do not add another disconnected AI widget; integrate attention into the operations console and operational-event model.
- Do not add direct provider SDK calls in routes/workers outside the central AI boundary.
- Do not create a generic send-email helper and call it “communications”; today only the welcome-email lifecycle is real.

## Documentation discipline

Treat these as the current canonical set:

1. `docs/system-state/TORCHIKO_STATE_OF_SYSTEM.md`
2. `docs/system-state/TORCHIKO_CAPABILITY_MATRIX.md`
3. `docs/system-state/TORCHIKO_AUDIT_BACKLOG.md`
4. this handoff
5. actual schema, routes, workers, contracts, executable gates, and tests

Older `docs/task-packets`, architecture packets, incident/cutover notes, and handoffs remain useful historical evidence, particularly for why constraints exist. They are not automatically the current product map.

## Safe change checklist

- [ ] Record initial branch, HEAD and `git status --short`.
- [ ] Identify tenant/platform/public scope and the backend authorization boundary.
- [ ] Trace the read/write path through route → domain action → schema/worker.
- [ ] Check legacy/native compatibility and public-surface implications.
- [ ] Add or update focused state-transition, ownership, idempotency and error tests.
- [ ] Update registries/budgets/manifests when adding models, bypasses, SQL, providers or public routes.
- [ ] Run focused tests, typecheck/lint and relevant static/integration gates.
- [ ] For UI, verify loading/empty/error/keyboard/mobile states; fixture pages must remain non-production.
- [ ] For jobs, verify retry, duplicate, lease expiry, cancellation and terminal-redrive behavior.
- [ ] For AI, verify budget/usage/error sanitization and a provider-disabled path.
- [ ] Inspect final diff without touching unrelated changes.
- [ ] State what was not verified externally.

## Known immediate priorities

Read the full backlog, but the near-term order is: golden venue lifecycle; current backup/restore and migration proof; truthful privacy and provider-down UX; one external operational-alert channel; readiness/worker/provider observability; bounded client insight/correction loop; measured legacy-to-native convergence. Avoid broad CRM, autonomous outreach, city knowledge graphs, or UI rewrites until the core lifecycle is repeatable.
