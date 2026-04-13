# PathFinderOS — Codex Task Packets

> Version: 1.0  
> Date: 2026-04-11  
> Depends on: `/docs/architecture.md`, `/docs/implementation-plan.md`, `/CLAUDE.md`  
> Purpose: Scoped, self-contained execution packets for Codex and AI coding agents  
> Rule: Read `/CLAUDE.md` before beginning any packet. Do not deviate from its conventions.

---

## How to Use These Packets

Each packet is a single Codex run. Hand over the packet text verbatim. Codex must not proceed beyond the stated scope. If Codex encounters something not covered by the packet, it must stop and report — not invent a solution.

Packets are ordered for sequential execution through T009. After that, parallelism is possible within marked boundaries. See Section A for the execution order.

---

<!-- ============================================================ -->
## PACKET-01 — Turborepo Monorepo Initialization
<!-- ============================================================ -->

### 1. Goal
Create the repository skeleton: all workspace package declarations, root tooling config, and placeholder source files. No application logic. No Next.js pages. No Prisma schema.

### 2. Why This Task Exists Now
Every subsequent task depends on the monorepo structure. The wrong structure here breaks all downstream work. This must be correct and passing CI before any feature work begins.

### 3. Scope
- Root `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- One `package.json` per workspace (12 total: 4 apps, 8 packages)
- Placeholder `src/index.ts` in each package
- `.env.example` with all required key names
- `.gitignore`
- `README.md` with one-paragraph project description and workspace list

### 4. Out of Scope
- Next.js app scaffolding (that is PACKET-03)
- TypeScript or ESLint configuration (that is PACKET-02)
- Any application logic whatsoever
- Vercel project creation or deployment configuration
- Database provisioning

### 5. Architectural Context
The platform is a Turborepo pnpm monorepo with these workspaces:

**Apps:** `apps/web`, `apps/dashboard`, `apps/admin`, `apps/workers`  
**Packages:** `packages/db`, `packages/api`, `packages/auth`, `packages/ui`, `packages/integrations`, `packages/jobs`, `packages/analytics`, `packages/config`

Full folder structure is in `/docs/implementation-plan.md` Section 2.

### 6. Required Repo Conventions
- Package manager: `pnpm` only. No `npm` or `yarn` files.
- All internal packages: `"private": true`
- No `"main"` field needed for packages yet — TypeScript path resolution handles it
- Turborepo pipeline must define tasks: `build`, `typecheck`, `lint`, `test`, `dev`
- `dev` task must have `"cache": false`

### 7. Files / Directories to Create

```
/turbo.json
/pnpm-workspace.yaml
/package.json                         (root — devDependencies only, no app code)
/.gitignore
/.env.example
/README.md
/apps/web/package.json
/apps/web/src/index.ts                (placeholder: export {})
/apps/dashboard/package.json
/apps/dashboard/src/index.ts
/apps/admin/package.json
/apps/admin/src/index.ts
/apps/workers/package.json
/apps/workers/src/index.ts
/packages/db/package.json
/packages/db/src/index.ts
/packages/api/package.json
/packages/api/src/index.ts
/packages/auth/package.json
/packages/auth/src/index.ts
/packages/ui/package.json
/packages/ui/src/index.ts
/packages/integrations/package.json
/packages/integrations/src/index.ts
/packages/jobs/package.json
/packages/jobs/src/index.ts
/packages/analytics/package.json
/packages/analytics/src/index.ts
/packages/config/package.json
/packages/config/src/index.ts
```

### 8. Files / Directories NOT to Touch
- `/docs/` — do not modify any documentation files
- `/CLAUDE.md` — do not modify

### 9. Data / Types / Interfaces Involved
None. This packet creates structure only.

### 10. Step-by-Step Implementation Plan

**Step 1 — Root package.json**
```json
{
  "name": "pathfinder",
  "private": true,
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write \"**/*.{ts,tsx,md}\""
  },
  "devDependencies": {
    "turbo": "latest",
    "prettier": "^3.0.0",
    "typescript": "^5.0.0"
  },
  "engines": { "node": ">=20", "pnpm": ">=9" },
  "packageManager": "pnpm@9.0.0"
}
```

**Step 2 — pnpm-workspace.yaml**
```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**Step 3 — turbo.json**
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [".env"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    }
  }
}
```

**Step 4 — Package names**  
Each `package.json` uses this naming convention:
- `apps/*` → `"name": "@pathfinder/web"`, `@pathfinder/dashboard"`, etc.
- `packages/*` → `"name": "@pathfinder/db"`, `"@pathfinder/api"`, etc.

**Step 5 — .env.example**  
Include exactly these keys, no values:
```
DATABASE_URL=
DIRECT_DATABASE_URL=
REDIS_URL=
CLERK_SECRET_KEY=
CLERK_PUBLISHABLE_KEY=
CLERK_WEBHOOK_SECRET=
ANTHROPIC_API_KEY=
INTEGRATION_ENCRYPTION_KEY=
STORAGE_BUCKET=
STORAGE_REGION=
STORAGE_ACCESS_KEY_ID=
STORAGE_SECRET_ACCESS_KEY=
POSTHOG_API_KEY=
RESEND_API_KEY=
```

**Step 6 — .gitignore**  
Include: `.next/`, `dist/`, `node_modules/`, `.env`, `.env.local`, `*.env`, `.turbo/`, `coverage/`

**Step 7 — Placeholder index.ts files**  
Each `src/index.ts`: `export {};`

**Step 8 — Verify**  
Run `pnpm install` from root. It must succeed. Run `turbo run build` — it must complete without error (empty packages produce no output, which is fine).

### 11. Acceptance Criteria
- `pnpm install` from repo root succeeds with no errors
- `turbo run build` exits 0
- All 12 workspaces appear in `pnpm list -r --depth 0`
- `.env.example` contains all 14 keys listed above
- No `package-lock.json` or `yarn.lock` exists
- All packages have `"private": true`

### 12. Tests to Add or Run
None for this packet. CI is added in PACKET-04.

### 13. Edge Cases to Handle
- If pnpm version mismatch: set `"packageManager": "pnpm@9.0.0"` in root `package.json`
- `turbo.json` pipeline entries for `typecheck`, `lint`, `test` need to exist even if packages don't implement them yet — Turborepo skips missing scripts gracefully when `"": {}` is used

### 14. Common Failure Modes
- **Circular dependency:** Accidentally listing a package as its own dependency
- **Wrong package names:** Using `pathfinder-db` instead of `@pathfinder/db` — use the scoped `@pathfinder/*` convention throughout
- **Missing workspace glob:** Forgetting to add `'packages/*'` to `pnpm-workspace.yaml` means packages won't resolve

### 15. Reviewer Checklist
- [ ] `pnpm install` clean from root
- [ ] `turbo run build` exits 0
- [ ] All 12 workspaces listed in workspace yaml
- [ ] No npm/yarn artifacts
- [ ] `.env.example` complete — no values, only keys
- [ ] All packages `"private": true`
- [ ] No application code anywhere

---

<!-- ============================================================ -->
## PACKET-02 — Shared Tooling Configuration
<!-- ============================================================ -->

### 1. Goal
Configure TypeScript strict mode, ESLint, Prettier, Husky, lint-staged, and the shared environment variable schema (Zod) across the entire monorepo.

### 2. Why This Task Exists Now
Every other package depends on these configs. TypeScript strict mode must be in place before any real code is written — retrofitting it is painful. The env schema ensures missing environment variables fail at startup, not at runtime.

### 3. Scope
- `packages/config/` — all shared config files
- Root `.prettierrc` and `.husky/` setup
- TypeScript base configs (base + Next.js variant)
- ESLint base configs (base + Next.js variant)
- `packages/config/src/env.ts` — Zod environment variable schema
- `packages/config/src/logger.ts` — structured JSON logger
- `packages/config/src/feature-flags.ts` — feature flag key registry (empty enum for now)
- `lint-staged` config in root `package.json`

### 4. Out of Scope
- Per-app `tsconfig.json` files (done when each app is scaffolded in PACKET-03)
- Vitest configuration (done in PACKET-04)
- Any application source files

### 5. Architectural Context
All apps extend `packages/config/typescript/nextjs.json`. All packages extend `packages/config/typescript/base.json`. TypeScript strict mode is non-negotiable (`"strict": true`, `"noUncheckedIndexedAccess": true`). The logger produces structured JSON — not `console.log`. The env schema is the single source of truth for required environment variables.

### 6. Required Repo Conventions
- `"strict": true` in all tsconfigs — no exceptions
- Logger must accept structured objects, not string concatenation
- Feature flag keys in `feature-flags.ts` are `const` enum or plain object — string literals elsewhere are forbidden
- `packages/config` has no runtime dependencies except `zod`

### 7. Files / Directories to Create

```
/packages/config/src/env.ts
/packages/config/src/logger.ts
/packages/config/src/feature-flags.ts
/packages/config/src/index.ts               (re-exports all of above)
/packages/config/typescript/base.json
/packages/config/typescript/nextjs.json
/packages/config/eslint/base.js
/packages/config/eslint/nextjs.js
/packages/config/package.json               (update with zod dependency)
/.prettierrc
/.husky/pre-commit
```

### 8. Files / Directories NOT to Touch
- Any file outside `packages/config/` or root config files
- `/docs/` and `/CLAUDE.md`

### 9. Data / Types / Interfaces Involved

**env.ts exports:**
```typescript
export const env: {
  DATABASE_URL: string
  DIRECT_DATABASE_URL: string
  REDIS_URL: string
  CLERK_SECRET_KEY: string
  CLERK_PUBLISHABLE_KEY: string
  CLERK_WEBHOOK_SECRET: string
  INTEGRATION_ENCRYPTION_KEY: string
  STORAGE_BUCKET: string
  STORAGE_REGION: string
  STORAGE_ACCESS_KEY_ID: string
  STORAGE_SECRET_ACCESS_KEY: string
  POSTHOG_API_KEY: string
  RESEND_API_KEY: string
}
```

**logger.ts exports:**
```typescript
export const logger: {
  info(fields: LogFields): void
  warn(fields: LogFields & { error?: string }): void
  error(fields: LogFields & { error: string; stack?: string }): void
  debug(fields: LogFields): void
}

type LogFields = {
  action: string
  tenantId?: string
  userId?: string
  [key: string]: unknown
}
```

### 10. Step-by-Step Implementation Plan

**Step 1 — packages/config/typescript/base.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "incremental": true
  },
  "exclude": ["node_modules"]
}
```

**Step 2 — packages/config/typescript/nextjs.json**  
Extend base, add: `"jsx": "preserve"`, `"plugins": [{ "name": "next" }]`, include `["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`

**Step 3 — packages/config/src/env.ts**  
Use `z.object({...}).parse(process.env)`. All fields `z.string().min(1)`. Export the parsed result as `env`. Call `parse()` at module load — missing vars throw immediately.

**Step 4 — packages/config/src/logger.ts**  
Implement using `JSON.stringify` with a timestamp field. No external logging dependency at this stage (add Axiom/Datadog transport later). Output to `stdout`. Never use `console.error` — route everything through the logger.

**Step 5 — packages/config/src/feature-flags.ts**  
Export a plain object `FEATURE_FLAGS` with an empty object for now. Add keys as features require them. First entry added in PACKET-12.

**Step 6 — ESLint base config**  
Extend `@typescript-eslint/recommended`. Add rules: `no-console: error`, `@typescript-eslint/no-explicit-any: error`, `@typescript-eslint/no-unused-vars: error`.

**Step 7 — .prettierrc**
```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

**Step 8 — Husky + lint-staged**  
`pnpm dlx husky init`. Pre-commit hook runs `pnpm lint-staged`. lint-staged config in root `package.json`:
```json
"lint-staged": {
  "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
  "*.{json,md}": ["prettier --write"]
}
```

### 11. Acceptance Criteria
- `packages/config` builds with `tsc --noEmit` and zero errors
- `env.ts`: if `DATABASE_URL` is removed from `process.env`, importing `env` throws a `ZodError` describing the missing field
- `logger.info({ action: 'test' })` outputs valid JSON to stdout
- `.prettierrc` is present and Prettier formats correctly on a test file
- Pre-commit hook runs without error on a clean commit

### 12. Tests to Add or Run
- Unit test for `env.ts`: mock `process.env` with a missing required key, assert that import throws
- Unit test for `logger.ts`: capture stdout, assert output is valid JSON with required fields

### 13. Edge Cases to Handle
- `env.ts` runs in both Node.js (workers, server-side) and Next.js edge runtime — avoid Node-only APIs in the parser
- `noUncheckedIndexedAccess` will require `?? default` patterns for array access everywhere — this is intentional

### 14. Common Failure Modes
- `z.string()` (not `z.string().min(1)`) allows empty strings — use `.min(1)` for all required vars
- Forgetting `"incremental": true` causes full TypeScript rebuilds in CI
- Husky not initialized after `pnpm install` — document that `pnpm prepare` installs hooks

### 15. Reviewer Checklist
- [ ] `tsc --noEmit` passes in `packages/config`
- [ ] `strict: true` confirmed in base tsconfig
- [ ] `no-console` ESLint rule is `error` not `warn`
- [ ] `env.ts` throws on missing required vars (tested)
- [ ] Logger outputs JSON — no plaintext strings
- [ ] No runtime dependencies in `packages/config` except `zod`
- [ ] `FEATURE_FLAGS` object exists in `feature-flags.ts` (even if empty)

---

<!-- ============================================================ -->
## PACKET-03 — Next.js App Scaffolding (All Three Apps)
<!-- ============================================================ -->

### 1. Goal
Create working Next.js 14 App Router applications for `apps/web`, `apps/dashboard`, and `apps/admin` with Clerk authentication middleware installed and the correct route group structure.

### 2. Why This Task Exists Now
The three apps are the deployment targets. Their structure — route groups, middleware, Clerk provider placement — must be correct from the start. Restructuring Next.js App Router layouts after business logic has been added is disruptive.

### 3. Scope
- `next.config.ts`, `tsconfig.json`, `tailwind.config.ts` for each app
- Root `app/layout.tsx` with `ClerkProvider` for each app
- Correct route group structure for `dashboard` and `admin` (`(auth)` and `(app)` groups)
- `middleware.ts` for each app — auth enforcement rules differ per app
- Placeholder pages (no real content)
- tRPC client file `lib/trpc.ts` in each app (client-side tRPC setup, not server-side yet)

### 4. Out of Scope
- tRPC server setup (PACKET-09)
- Prisma or database setup (PACKET-05)
- Any real page content or data fetching
- `packages/ui` component library (separate packet)
- Vercel deployment configuration

### 5. Architectural Context
- All three apps use Next.js 14+ App Router
- `apps/web`: public, no auth gate in middleware, rate limiting only
- `apps/dashboard`: `/(auth)` routes are public; `/(app)` routes require Clerk session + org membership
- `apps/admin`: every route except `/sign-in` requires Clerk session AND `PLATFORM_ADMIN` claim in public metadata
- Clerk `<ClerkProvider>` wraps each app's root layout
- `apps/admin` deployed on a separate domain — `NEXT_PUBLIC_ADMIN_URL` env var

### 6. Required Repo Conventions
- `tsconfig.json` in each app extends `@pathfinder/config/typescript/nextjs.json`
- Use `clerkMiddleware` (Clerk v5 API) not deprecated `authMiddleware`
- `apps/admin` middleware must return a `403` response (not a redirect to dashboard) for authenticated non-admin users
- No Pages Router files anywhere

### 7. Files / Directories to Create

```
apps/web/
  app/layout.tsx
  app/page.tsx               (redirect to /[tenantSlug] or placeholder)
  app/not-found.tsx
  middleware.ts
  next.config.ts
  tsconfig.json
  tailwind.config.ts
  package.json               (update with next, react, @clerk/nextjs, tailwindcss)

apps/dashboard/
  app/layout.tsx
  app/(auth)/sign-in/[[...sign-in]]/page.tsx
  app/(auth)/sign-up/[[...sign-up]]/page.tsx
  app/(app)/layout.tsx       (auth gate + tenant resolver)
  app/(app)/page.tsx         (redirect to /listings)
  middleware.ts
  next.config.ts
  tsconfig.json
  tailwind.config.ts
  package.json

apps/admin/
  app/layout.tsx
  app/(auth)/sign-in/[[...sign-in]]/page.tsx
  app/(app)/layout.tsx       (PLATFORM_ADMIN gate)
  app/(app)/page.tsx         (placeholder dashboard home)
  middleware.ts
  next.config.ts
  tsconfig.json
  tailwind.config.ts
  package.json
```

### 8. Files / Directories NOT to Touch
- `packages/` — no package changes in this packet
- `apps/workers/` — separate concern
- `/docs/`, `/CLAUDE.md`

### 9. Data / Types / Interfaces Involved
- Clerk session type (from `@clerk/nextjs/server`)
- `auth()` from `@clerk/nextjs/server` for server-side session reading

### 10. Step-by-Step Implementation Plan

**Step 1 — Install dependencies per app**  
Each app's `package.json` dependencies: `next`, `react`, `react-dom`, `@clerk/nextjs`, `tailwindcss`, `postcss`, `autoprefixer`. All apps share same Next.js and Clerk versions — pin them.

**Step 2 — apps/web/middleware.ts**
```typescript
import { clerkMiddleware } from '@clerk/nextjs/server'
// Web app is public — Clerk middleware runs but does not enforce auth
// Rate limiting added in a later packet
export default clerkMiddleware()
export const config = { matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|...)).*)'] }
```

**Step 3 — apps/dashboard/middleware.ts**  
Use `clerkMiddleware` with a callback: protect all `/(app)` routes. Allow `/(auth)` routes. If authenticated but no `orgId`, redirect to `/onboarding`.

**Step 4 — apps/admin/middleware.ts**  
Use `clerkMiddleware` with a callback:
- Allow `/sign-in` route
- For all other routes: if no session → redirect to `/sign-in`
- If session but `sessionClaims.publicMetadata.platform_role !== 'PLATFORM_ADMIN'` → return `new Response('Forbidden', { status: 403 })`

**Step 5 — ClerkProvider placement**  
Root `app/layout.tsx` in each app wraps children in `<ClerkProvider>`. Dashboard and admin also set `<html lang="en">` and import global CSS.

**Step 6 — Route groups**  
- `(auth)` group: no layout wrapper needed beyond ClerkProvider
- `(app)` group in dashboard: layout reads `auth()`, checks `orgId`, redirects to `/onboarding` if absent
- `(app)` group in admin: layout reads `auth()`, checks `publicMetadata.platform_role`

**Step 7 — Placeholder pages**  
Each `page.tsx` returns a minimal React component with the app name as the title. No data fetching yet.

**Step 8 — Tailwind setup**  
Each app's `tailwind.config.ts` extends `packages/ui` shared config (reference path, even though `packages/ui` is not built yet — the reference is forward-compatible).

### 11. Acceptance Criteria
- `pnpm dev` starts all three apps without errors
- Visiting `apps/admin` as a non-authenticated user redirects to `/sign-in`
- Visiting `apps/admin` as an authenticated user without `PLATFORM_ADMIN` metadata returns `403`
- `apps/dashboard` `/(app)` routes redirect unauthenticated users to `/sign-in`
- `apps/web` serves its root page without authentication
- `tsc --noEmit` passes in all three apps

### 12. Tests to Add or Run
No unit tests for this packet. Middleware behavior is validated manually and by E2E tests added in a later packet.

### 13. Edge Cases to Handle
- Clerk `orgId` can be null even when authenticated (user has no org) — dashboard `(app)` layout must handle this by redirecting to `/onboarding`, not crashing
- Admin `403` response must not contain any HTML that links to the dashboard — it is a plain text response

### 14. Common Failure Modes
- Using `authMiddleware` (deprecated Clerk v4) instead of `clerkMiddleware` — check Clerk v5 docs
- `publicMetadata.platform_role` check with `!== 'PLATFORM_ADMIN'` instead of checking `=== 'PLATFORM_ADMIN'` — undefined is not equal to the string, but be explicit
- Missing `[[...sign-in]]` catch-all route segment causes Clerk hosted UI to 404

### 15. Reviewer Checklist
- [ ] All three apps start without errors
- [ ] Admin `403` fires for authenticated non-admin user (test manually)
- [ ] Dashboard `/(app)` redirects unauthenticated users
- [ ] `tsconfig.json` in each app extends the shared config
- [ ] No Pages Router files exist
- [ ] No business logic in any middleware or layout

---

<!-- ============================================================ -->
## PACKET-04 — CI Pipeline and GitHub Actions
<!-- ============================================================ -->

### 0. Environment Setup (run before anything else)

pnpm is the required package manager. The repo does **not** use corepack — install pnpm directly via npm, then install deps:

```sh
npm install -g pnpm@9
pnpm install --frozen-lockfile
```

Do **not** use `corepack enable` or `corepack prepare` — the `packageManager` field has been intentionally removed from `package.json` to avoid corepack intercepting pnpm calls and hanging on network fetches.

A `.npmrc` at the repo root sets `network-timeout=30000` so stalled requests fail fast instead of hanging forever.

### 1. Goal
Create a GitHub Actions CI workflow that runs typecheck, lint, and tests on every PR. Block merges to `main` without passing CI.

### 2. Why This Task Exists Now
CI is a safety net for all subsequent work. Without it, type errors and lint violations accumulate silently. It must be in place before any feature code is written.

### 3. Scope
- `.github/workflows/ci.yml`
- Vitest configuration in `packages/config` and root
- `vitest.config.ts` stubs in packages that will have tests
- Root `package.json` test script

### 4. Out of Scope
- Deployment workflows (`deploy.yml`) — not needed until apps have real content
- Test database provisioning — integration tests use a local DB; CI uses a service container
- Playwright E2E setup — later packet

### 5. Architectural Context
CI uses Turborepo's `--filter` and remote cache. The pipeline runs: `pnpm install --frozen-lockfile` → `turbo run typecheck` → `turbo run lint` → `turbo run test`. Turbo remote cache is configured via `TURBO_TOKEN` secret.

### 6. Required Repo Conventions
- `pnpm install --frozen-lockfile` in CI — hard requirement
- `pnpm` version pinned in `engines` field
- Vitest (not Jest) for all unit and integration tests
- Test files: `*.test.ts` for unit, `*.integration.test.ts` for integration

### 7. Files / Directories to Create

```
/.github/workflows/ci.yml
/vitest.config.ts                    (root workspace config)
/packages/config/vitest.config.ts
/packages/db/vitest.config.ts        (stub)
/packages/api/vitest.config.ts       (stub)
/packages/auth/vitest.config.ts      (stub)
```

### 8. Files / Directories NOT to Touch
- Any source files in `src/`
- `/docs/`, `/CLAUDE.md`

### 9. Data / Types / Interfaces Involved
None — configuration only.

### 10. Step-by-Step Implementation Plan

**Step 1 — ci.yml**
```yaml
name: CI
on:
  push:
    branches: ['**']
  pull_request:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpassword
          POSTGRES_DB: pathfinder_test
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
    env:
      DATABASE_URL: postgresql://postgres:testpassword@localhost:5432/pathfinder_test
      DIRECT_DATABASE_URL: postgresql://postgres:testpassword@localhost:5432/pathfinder_test
      REDIS_URL: redis://localhost:6379
      CLERK_SECRET_KEY: test_clerk_secret
      CLERK_PUBLISHABLE_KEY: test_clerk_pub
      CLERK_WEBHOOK_SECRET: test_webhook_secret
      INTEGRATION_ENCRYPTION_KEY: test_encryption_key_32_chars_long!
      STORAGE_BUCKET: test-bucket
      STORAGE_REGION: us-east-1
      STORAGE_ACCESS_KEY_ID: test
      STORAGE_SECRET_ACCESS_KEY: test
      POSTHOG_API_KEY: test
      RESEND_API_KEY: test
      TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9.15.4 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo run typecheck
      - run: pnpm turbo run lint
      - run: pnpm turbo run test
```

**Step 2 — Root vitest.config.ts**  
Workspace config referencing all package vitest configs.

**Step 3 — Per-package vitest.config.ts stubs**  
Minimal config: `defineConfig({ test: { environment: 'node' } })`. Packages with DB tests will add `globalSetup` later.

**Step 4 — Add test scripts**  
Each `package.json` gains `"test": "vitest run"` and `"test:watch": "vitest"`.

### 11. Acceptance Criteria
- CI workflow file is valid YAML (validate with `actionlint` or GitHub's YAML validator)
- `pnpm turbo run test` exits 0 on a clean repo (no test files = pass)
- `pnpm install --frozen-lockfile` succeeds in CI
- CI runs on every push and PR

### 12. Tests to Add or Run
No new tests in this packet. CI runs whatever tests exist (currently none).

### 13. Edge Cases to Handle
- `TURBO_TOKEN` secret not set: Turbo falls back to local cache — CI still works, just slower. Do not fail on missing token.
- Test env vars use placeholder values — they will fail if real Clerk calls are made. Tests must mock Clerk at this stage.

### 14. Common Failure Modes
- `--frozen-lockfile` fails if `pnpm-lock.yaml` is not committed — ensure it is in git
- Turbo cache conflicts: set `TURBO_TEAM` to avoid cross-project cache collisions
- Postgres service container not ready when migration runs — use `--health-*` options (already in the yaml above)

### 15. Reviewer Checklist
- [ ] CI YAML is syntactically valid
- [ ] `--frozen-lockfile` present on `pnpm install`
- [ ] All 14 env vars present in CI env block (including `ANTHROPIC_API_KEY`)
- [ ] Test scripts added to all packages
- [ ] No secrets hardcoded — only test placeholder values for non-sensitive keys

---

<!-- ============================================================ -->
## PACKET-05 — Prisma Schema: Migration 001 (Identity Foundation)
<!-- ============================================================ -->

### 1. Goal
Define and migrate the foundational identity tables: `User`, `Tenant`, `TenantMembership`. Create the Prisma client singleton in `packages/db`.

### 2. Why This Task Exists Now
All business tables depend on `Tenant`. All permission checks depend on `TenantMembership`. The auth package (next packet) reads these tables. Nothing else can be built without this foundation.

### 3. Scope
- `packages/db/prisma/schema.prisma` — add `User`, `Tenant`, `TenantMembership` models
- First migration: `001_identity_foundation`
- `packages/db/src/client.ts` — Prisma singleton
- `packages/db/src/index.ts` — re-export `db` and all generated types
- `packages/db/package.json` — add `@prisma/client`, `prisma` dev dep
- `packages/db/prisma/seed.ts` — stub only (no data yet)

### 4. Out of Scope
- Tenant isolation middleware (PACKET-07)
- Audit log middleware (PACKET-07)
- All other tables (separate packets)
- Any tRPC procedures

### 5. Architectural Context
- `User.id` = Clerk user ID — `String`, not auto-generated UUID
- `Tenant.id` = Clerk organization ID — `String`, not auto-generated UUID
- `TenantMembership.role` is a Prisma enum: `OWNER`, `MANAGER`, `STAFF`
- The Prisma client singleton uses `global.prisma` to prevent multiple instances in Next.js hot reload
- `packages/db` is the **only** package that imports `@prisma/client`

### 6. Required Repo Conventions
- No `@default(uuid())` on `User.id` or `Tenant.id` — these come from Clerk
- `onDelete: Restrict` on all foreign keys unless cascading is documented
- `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt` on all mutable tables
- Run migrations from `packages/db` only: `pnpm --filter @pathfinder/db db:migrate`

### 7. Files / Directories to Create or Modify

```
packages/db/
  prisma/
    schema.prisma
    migrations/
      001_identity_foundation/
        migration.sql
  src/
    client.ts
    index.ts
  package.json                (add @prisma/client, prisma devDep, db:migrate script)
```

### 8. Files / Directories NOT to Touch
- Any file outside `packages/db/`
- Existing `packages/db/src/index.ts` placeholder (replace it)

### 9. Data / Types / Interfaces Involved

```prisma
model User {
  id          String              @id              // Clerk user ID
  email       String              @unique
  fullName    String?
  avatarUrl   String?
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  memberships TenantMembership[]
}

model Tenant {
  id          String              @id              // Clerk org ID
  name        String
  slug        String              @unique
  planTier    String              @default("free")
  status      TenantStatus        @default(ACTIVE)
  config      Json                @default("{}")
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  memberships TenantMembership[]
}

model TenantMembership {
  id          String              @id @default(cuid())
  tenantId    String
  userId      String
  role        TenantRole
  status      MembershipStatus    @default(ACTIVE)
  invitedBy   String?
  joinedAt    DateTime?
  createdAt   DateTime            @default(now())
  updatedAt   DateTime            @updatedAt
  tenant      Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  user        User                @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@unique([tenantId, userId])
  @@index([tenantId])
  @@index([userId])
}

enum TenantRole   { OWNER MANAGER STAFF }
enum TenantStatus { ACTIVE SUSPENDED TRIAL }
enum MembershipStatus { ACTIVE INVITED REMOVED }
```

### 10. Step-by-Step Implementation Plan

**Step 1 — schema.prisma**  
Add `datasource`, `generator`, and the three models above. Generator: `provider = "prisma-client-js"`.

**Step 2 — Run migration**  
`pnpm prisma migrate dev --name 001_identity_foundation`

**Step 3 — client.ts singleton**
```typescript
import { PrismaClient } from '@prisma/client'

const globalForPrisma = global as unknown as { prisma: PrismaClient }

export const db = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

**Step 4 — index.ts**  
Export `{ db }` and re-export all Prisma generated types: `export type { User, Tenant, TenantMembership, TenantRole, TenantStatus, MembershipStatus } from '@prisma/client'`

**Step 5 — Package scripts**  
Add to `package.json`:
```json
"scripts": {
  "db:migrate": "prisma migrate dev",
  "db:migrate:prod": "prisma migrate deploy",
  "db:generate": "prisma generate",
  "db:studio": "prisma studio",
  "db:seed": "tsx prisma/seed.ts"
}
```

### 11. Acceptance Criteria
- `pnpm --filter @pathfinder/db db:migrate` runs without error against a fresh Postgres DB
- `pnpm --filter @pathfinder/db db:generate` produces types
- `import { db } from '@pathfinder/db'` resolves without error in other packages
- `import type { Tenant } from '@pathfinder/db'` resolves the Prisma type
- Schema has all three models with correct field types
- `tsc --noEmit` passes in `packages/db`

### 12. Tests to Add or Run
No tests in this packet — the isolation middleware (tested in PACKET-07) uses these tables.

### 13. Edge Cases to Handle
- `User.email` must be unique — Clerk guarantees this but the DB constraint enforces it at the data layer
- `Tenant.slug` must be unique — used for public URL routing
- `TenantMembership` has a `@@unique([tenantId, userId])` — same user cannot have two memberships in one tenant

### 14. Common Failure Modes
- Using `@default(cuid())` on `User.id` or `Tenant.id` — these IDs come from Clerk, not Prisma
- Missing `@@unique([tenantId, userId])` on `TenantMembership` — allows duplicate memberships
- Not running `db:generate` after schema changes — types will be stale

### 15. Reviewer Checklist
- [ ] `User.id` and `Tenant.id` have no `@default` directive
- [ ] `TenantMembership` has `@@unique([tenantId, userId])`
- [ ] `onDelete: Restrict` on all FKs
- [ ] Singleton pattern uses `global.prisma`
- [ ] `@prisma/client` not imported anywhere except `packages/db`
- [ ] Migration file exists in `prisma/migrations/`

---

<!-- ============================================================ -->
## PACKET-06 — Prisma Schema: Migration 002 (Platform Controls)
<!-- ============================================================ -->

### 1. Goal
Add `AuditLog`, `TenantFeatureFlag`, and `PlatformConfig` tables. Implement the `writeAuditLog()` helper and `featureEnabled()` utility.

### 2. Why This Task Exists Now
The auth package (PACKET-08) calls `featureEnabled()`. The tRPC middleware (PACKET-09) uses `writeAuditLog()`. These tables must exist before any business procedures are built.

### 3. Scope
- Add three models to `schema.prisma`
- New migration: `002_platform_controls`
- `packages/db/src/helpers/audit.ts` — `writeAuditLog()` function
- `packages/db/src/helpers/feature-flags.ts` — `featureEnabled()` function
- Update `packages/db/src/index.ts` to export new helpers and types

### 4. Out of Scope
- Redis caching for feature flags (added later when Redis is wired)
- Admin procedures for managing feature flags (PACKET-14)
- The Prisma audit middleware that auto-writes logs (part of PACKET-07)

### 5. Architectural Context
- `AuditLog` is append-only — no `updatedAt`, no soft-delete, no hard-delete ever
- `AuditLog.tenantId` is nullable — platform-level actions set it to null
- `AuditLog` has no FK to `Tenant` — logs must survive tenant deletion
- `TenantFeatureFlag` has `@@unique([tenantId, flagKey])`
- `featureEnabled()` queries the DB directly at MVP (Redis cache added later)

### 6. Required Repo Conventions
- `AuditLog` must have zero fields that can be updated after creation
- `writeAuditLog()` is the only way to write to `AuditLog` — direct `db.auditLog.create()` calls are forbidden
- Feature flag keys must reference `FEATURE_FLAGS` from `packages/config` — not hardcoded strings

### 7. Files / Directories to Create or Modify

```
packages/db/
  prisma/
    schema.prisma                (add 3 models)
    migrations/
      002_platform_controls/
        migration.sql
  src/
    helpers/
      audit.ts
      feature-flags.ts
    index.ts                     (export new helpers and types)
```

### 8. Files / Directories NOT to Touch
- Any file outside `packages/db/`
- Migration 001 files

### 9. Data / Types / Interfaces Involved

```prisma
model AuditLog {
  id          String   @id @default(cuid())
  tenantId    String?                           // null for platform-level actions
  actorId     String                            // user ID performing the action
  actorRole   String                            // role at time of action
  action      String                            // e.g., "booking.cancelled"
  targetType  String                            // entity type
  targetId    String                            // entity ID
  beforeState Json?
  afterState  Json?
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime @default(now())

  @@index([tenantId, createdAt])
  @@index([actorId])
}

model TenantFeatureFlag {
  id        String   @id @default(cuid())
  tenantId  String
  flagKey   String
  enabled   Boolean  @default(false)
  metadata  Json     @default("{}")
  setBy     String
  setAt     DateTime @default(now())

  @@unique([tenantId, flagKey])
  @@index([tenantId])
}

model PlatformConfig {
  key       String   @id
  value     Json
  updatedBy String
  updatedAt DateTime @updatedAt
}
```

**writeAuditLog params:**
```typescript
type WriteAuditLogParams = {
  tenantId?: string
  actorId: string
  actorRole: string
  action: string
  targetType: string
  targetId: string
  beforeState?: Record<string, unknown>
  afterState?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}
```

### 10. Step-by-Step Implementation Plan

**Step 1 — Add models to schema.prisma**  
Add the three models. Note: `AuditLog` has NO `updatedAt` field — this is intentional.

**Step 2 — Run migration**  
`pnpm prisma migrate dev --name 002_platform_controls`

**Step 3 — audit.ts**
```typescript
import { db } from '../client'
export async function writeAuditLog(params: WriteAuditLogParams): Promise<void> {
  await db.auditLog.create({ data: params })
}
```

**Step 4 — feature-flags.ts**
```typescript
import { db } from '../client'
export async function featureEnabled(tenantId: string, flagKey: string): Promise<boolean> {
  const flag = await db.tenantFeatureFlag.findUnique({
    where: { tenantId_flagKey: { tenantId, flagKey } },
    select: { enabled: true },
  })
  return flag?.enabled ?? false
}
```

**Step 5 — Update index.ts exports**

### 11. Acceptance Criteria
- Migration runs cleanly
- `writeAuditLog({ actorId: 'user_1', actorRole: 'OWNER', action: 'test', targetType: 'Tenant', targetId: 'tenant_1' })` inserts a row
- `featureEnabled('tenant_1', 'nonexistent.flag')` returns `false` (not throws)
- `AuditLog` table has no `updatedAt` column — verify in migration SQL
- `tsc --noEmit` passes

### 12. Tests to Add or Run
- Unit test: `writeAuditLog` with tenantId null creates a platform-level log row
- Unit test: `featureEnabled` returns false for non-existent flag
- Unit test: `featureEnabled` returns true for a flag set to enabled

### 13. Edge Cases to Handle
- `featureEnabled` with a non-existent `tenantId` must return `false`, not throw a FK error
- `writeAuditLog` must not throw — if the DB call fails, log the error and swallow it (analytics-style) to avoid breaking the main flow

### 14. Common Failure Modes
- Adding `updatedAt` to `AuditLog` — explicitly forbidden, reviewer must catch this
- Using `db.auditLog.upsert()` anywhere — append-only means create-only

### 15. Reviewer Checklist
- [ ] `AuditLog` has no `updatedAt` field in schema or migration SQL
- [ ] `AuditLog.tenantId` has no FK constraint to `Tenant`
- [ ] `TenantFeatureFlag` has `@@unique([tenantId, flagKey])`
- [ ] `writeAuditLog` is the only export for writing audit logs (no raw `db.auditLog.create` in helpers)
- [ ] `featureEnabled` returns `false` (not throws) for missing flags

---

<!-- ============================================================ -->
## PACKET-07 — Prisma Tenant Isolation Middleware
<!-- ============================================================ -->

### 1. Goal
Implement and fully test the Prisma middleware that enforces tenant isolation on every query. This is the most critical security control in the platform.

### 2. Why This Task Exists Now
All subsequent business tables are tenanted. The middleware must exist before any tenanted table is added — otherwise every query against those tables would be unguarded from the start.

### 3. Scope
- `packages/db/src/middleware/tenant-isolation.ts` — the middleware
- `packages/db/src/middleware/tenant-isolation.test.ts` — must achieve 100% branch coverage
- Update `packages/db/src/client.ts` to register the middleware
- Define the list of tenanted tables (as a constant, not inlined)

### 4. Out of Scope
- The Prisma audit log middleware (separate concern, added later)
- Business table migrations (PACKET-11)
- Any tRPC code

### 5. Architectural Context
The middleware intercepts all Prisma operations. For queries against tenanted tables, if `where.tenant_id` (or `tenantId` in camelCase) is absent, it **throws** `TenantIsolationError`. Platform-level tables are explicitly excluded. Admin bypass requires an explicit `bypassTenantIsolation: true` flag passed via Prisma's `$extends` context or a custom client factory.

The list of tenanted tables at this stage: `TenantMembership`, `TenantFeatureFlag`. More will be added in PACKET-11.

### 6. Required Repo Conventions
- Throw `TenantIsolationError extends Error` — not a generic `Error`
- The bypass flag requires explicit opt-in — it is never a default
- 100% branch coverage on this file is a CI gate — add a Vitest coverage threshold
- Do not use this middleware as the only isolation check — tRPC procedures also verify `entity.tenantId === ctx.activeTenantId`

### 7. Files / Directories to Create or Modify

```
packages/db/
  src/
    middleware/
      tenant-isolation.ts
      tenant-isolation.test.ts
    client.ts                    (register middleware)
    tenanted-tables.ts           (constant list of tenanted table names)
```

### 8. Files / Directories NOT to Touch
- Migration files
- `packages/auth/` or `packages/api/`

### 9. Data / Types / Interfaces Involved

```typescript
export class TenantIsolationError extends Error {
  constructor(model: string, operation: string) {
    super(`Tenant isolation violated: query on '${model}' (${operation}) missing tenant_id`)
    this.name = 'TenantIsolationError'
  }
}

export const TENANTED_TABLES: readonly string[] = [
  'TenantMembership',
  'TenantFeatureFlag',
  // PACKET-11 adds: Listing, Event, GuestUser, Booking
  // PACKET-11b adds: AnalyticsEvent
  // PACKET-14 adds: IntegrationConnection, IntegrationSyncLog, IntegrationWebhookEvent, JobRecord
]

// Platform-level tables (no tenant filter required)
export const PLATFORM_TABLES: readonly string[] = [
  'User',
  'Tenant',
  'AuditLog',
  'PlatformConfig',
]
```

### 10. Step-by-Step Implementation Plan

**Step 1 — Implement middleware**  
Prisma middleware using `.use()`. For each operation:
1. Check if `params.model` is in `TENANTED_TABLES`
2. If yes, check if `params.args.where?.tenantId` or `params.args.data?.tenantId` is present
3. If absent and bypass flag is not set, throw `TenantIsolationError`
4. For `create` operations, check `data.tenantId` not `where.tenantId`
5. For `findFirst`, `findMany`, `update`, `delete`, `upsert` — check `where.tenantId`

**Step 2 — Bypass mechanism**  
Create `createAdminDbClient()` factory function that returns a Prisma client with bypass enabled. This function is only importable from within `packages/db` and is consumed only by admin procedures.

**Step 3 — Register in client.ts**  
`db.$use(tenantIsolationMiddleware)`

**Step 4 — Tests**  
Write tests for every branch:
- `findMany` on tenanted table WITH `tenantId` → passes
- `findMany` on tenanted table WITHOUT `tenantId` → throws `TenantIsolationError`
- `create` on tenanted table WITH `tenantId` in data → passes
- `create` on tenanted table WITHOUT `tenantId` → throws
- `findMany` on platform table WITHOUT `tenantId` → passes
- Admin bypass client: `findMany` on tenanted table without `tenantId` → passes

### 11. Acceptance Criteria
- All 6 test cases above pass
- `vitest run --coverage` shows 100% branch coverage for `tenant-isolation.ts`
- `db.tenantMembership.findMany({})` (no where clause) throws `TenantIsolationError`
- `db.tenantMembership.findMany({ where: { tenantId: 'org_1' } })` does not throw
- `db.user.findMany({})` does not throw

### 12. Tests to Add or Run
- All 6 cases listed in Step 4 above
- Add to CI: `vitest run --coverage --coverage.thresholds.lines=100` for this file specifically

### 13. Edge Cases to Handle
- `update` with `updateMany` — both `where.tenantId` variants
- `upsert` — check both `where` and `create.tenantId`
- `deleteMany` — must check `where.tenantId`
- Nested writes (e.g., `create` with nested `memberships.create`) — only check the top-level model

### 14. Common Failure Modes
- Using `== null` instead of checking key existence — `undefined` and `null` must both be caught
- Not covering the `deleteMany` operation — it's easy to miss
- Bypass flag being a module-level variable instead of per-client — would make bypass global

### 15. Reviewer Checklist
- [ ] `TenantIsolationError` is a typed class, not a generic `Error`
- [ ] 100% branch coverage confirmed in test output
- [ ] `createAdminDbClient()` is not exported from `packages/db/src/index.ts` — only available internally
- [ ] Middleware registered in `client.ts`
- [ ] `TENANTED_TABLES` and `PLATFORM_TABLES` are exported constants (so they can be checked in future)
- [ ] All 6 test cases present

---

<!-- ============================================================ -->
## PACKET-08 — packages/auth: Session Resolution and Permission Guards
<!-- ============================================================ -->

### 1. Goal
Build `packages/auth` — the single source of truth for session resolution, tenant context, and permission enforcement. All auth-related logic in the platform goes through this package.

### 2. Why This Task Exists Now
The tRPC context builder (PACKET-09) depends on this package. No tRPC procedure can enforce permissions without `requireTenantRole` and `requirePlatformAdmin`.

### 3. Scope
- `packages/auth/src/server.ts` — server-side session helpers
- `packages/auth/src/session.ts` — `resolveSession()` and `SessionContext` type
- `packages/auth/src/permissions.ts` — `requireTenantRole()`, `requirePlatformAdmin()`
- `packages/auth/src/client.ts` — thin re-exports of Clerk client hooks
- `packages/auth/src/index.ts`
- `packages/auth/package.json` — add `@clerk/nextjs` dependency

### 4. Out of Scope
- tRPC middleware wiring (PACKET-09)
- Clerk webhook handling (PACKET-10)
- Any UI components

### 5. Architectural Context
- `activeTenantId` is always resolved from the Clerk JWT `org_id` claim — never from request body/URL
- `isPlatformAdmin` is resolved from Clerk public metadata: `publicMetadata.platform_role === 'PLATFORM_ADMIN'`
- Role hierarchy is numeric: `OWNER=3 > MANAGER=2 > STAFF=1`
- `requireTenantRole` throws `TRPCError({ code: 'FORBIDDEN' })` — not a generic error
- This package imports `@clerk/nextjs` — no other package may do so

### 6. Required Repo Conventions
- `isPlatformAdmin` check: `=== 'PLATFORM_ADMIN'` — not truthy
- Role comparison uses numeric values — not string equality
- `resolveSession` throws `TRPCError({ code: 'UNAUTHORIZED' })` if no valid session
- `packages/auth` does NOT import `packages/db` — it does not make database calls

### 7. Files / Directories to Create

```
packages/auth/
  src/
    server.ts
    session.ts
    permissions.ts
    client.ts
    index.ts
  package.json             (update with @clerk/nextjs, trpc peer dep)
```

### 8. Files / Directories NOT to Touch
- `packages/db/` — auth makes no DB calls
- Any app files

### 9. Data / Types / Interfaces Involved

```typescript
// session.ts
export type SessionContext = {
  userId: string
  activeTenantId: string | null
  role: TenantRole | null
  isPlatformAdmin: boolean
}

// permissions.ts
export function requireTenantRole(
  ctx: SessionContext,
  minRole: TenantRole
): asserts ctx is SessionContext & { activeTenantId: string; role: TenantRole }

export function requirePlatformAdmin(
  ctx: SessionContext
): asserts ctx is SessionContext & { isPlatformAdmin: true }

// Role hierarchy values
const ROLE_HIERARCHY: Record<TenantRole, number> = {
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
}
```

### 10. Step-by-Step Implementation Plan

**Step 1 — session.ts**  
`resolveSession(request: Request): Promise<SessionContext>` — calls `auth()` from `@clerk/nextjs/server`, reads `userId`, `orgId`, `orgRole`, and `publicMetadata.platform_role`. Returns `SessionContext`. Throws `TRPCError({ code: 'UNAUTHORIZED' })` if `userId` is null.

**Step 2 — server.ts**  
Export `currentUser()` and `requireAuth()` thin wrappers that call Clerk's `currentUser()` from `@clerk/nextjs/server`.

**Step 3 — permissions.ts**  
Implement `requireTenantRole` using numeric role comparison. Throw `TRPCError({ code: 'FORBIDDEN', message: 'Insufficient role' })`. Implement `requirePlatformAdmin` — throw same error if `!ctx.isPlatformAdmin`.

**Step 4 — client.ts**  
Re-export: `useAuth`, `useUser`, `useOrganization`, `SignInButton`, `SignOutButton` from `@clerk/nextjs`. These re-exports allow apps to import from `@pathfinder/auth` instead of directly from Clerk.

**Step 5 — Tests**  
Unit test `requireTenantRole` with all role combinations. Unit test `requirePlatformAdmin` with both states.

### 11. Acceptance Criteria
- `requireTenantRole({ role: 'STAFF' }, 'MANAGER')` throws `TRPCError` with code `FORBIDDEN`
- `requireTenantRole({ role: 'OWNER' }, 'MANAGER')` does not throw
- `requirePlatformAdmin({ isPlatformAdmin: false })` throws `TRPCError` with code `FORBIDDEN`
- `resolveSession` called with no Clerk session throws `TRPCError` with code `UNAUTHORIZED`
- `tsc --noEmit` passes
- No imports of `@clerk/nextjs` outside this package

### 12. Tests to Add or Run
- Unit: all role combinations for `requireTenantRole` (6 cases: 3 roles × 2 directions)
- Unit: `requirePlatformAdmin` true and false cases
- Unit: `resolveSession` with mocked Clerk `auth()` returning null userId

### 13. Edge Cases to Handle
- `orgRole` from Clerk uses their naming convention (`org:admin`, `org:member`) — map these to `OWNER/MANAGER/STAFF` in `resolveSession`. Document this mapping explicitly in code comments.
- A user with no active org has `activeTenantId: null` and `role: null` — this is valid for the onboarding flow

### 14. Common Failure Modes
- Using Clerk's `orgRole` string directly as `TenantRole` — they are different strings and must be mapped
- `isPlatformAdmin` check with `!!metadata.platform_role` — a future role like `PLATFORM_VIEWER` would incorrectly pass

### 15. Reviewer Checklist
- [ ] `activeTenantId` sourced from Clerk JWT, never from request params
- [ ] `isPlatformAdmin` checks `=== 'PLATFORM_ADMIN'` (not truthy)
- [ ] Role hierarchy uses numeric comparison
- [ ] `packages/auth` does not import `packages/db`
- [ ] Clerk orgRole → TenantRole mapping is documented and tested
- [ ] All unit tests pass

---

<!-- ============================================================ -->
## PACKET-09 — tRPC API Layer Foundation
<!-- ============================================================ -->

### 1. Goal
Set up the tRPC layer with context resolution, the four base procedure types, and the root router. Mount the router in all three Next.js apps.

### 2. Why This Task Exists Now
Every feature packet that adds a tRPC procedure depends on this foundation. The context type, base procedures, and router mounting pattern must be established and consistent before any real procedures are written.

### 3. Scope
- `packages/api/src/trpc.ts` — tRPC init, context type, base procedures
- `packages/api/src/context.ts` — `createTRPCContext()` function
- `packages/api/src/middleware/` — four middleware files
- `packages/api/src/routers/_app.ts` — root router (empty stubs)
- `packages/api/src/routers/admin/_admin.ts` — admin sub-router stub
- `packages/api/src/index.ts`
- `apps/*/app/api/trpc/[trpc]/route.ts` — tRPC handler in each app
- `apps/*/lib/trpc.ts` — tRPC client in each app

### 4. Out of Scope
- Any actual procedures (PACKET-12 onwards)
- Clerk webhook handler (PACKET-10)
- Database-backed context (procedures add their own DB calls)

### 5. Architectural Context
The tRPC context builder calls `resolveSession()` from `packages/auth`. Context includes: `db`, `session` (the `SessionContext` from PACKET-08). The four base procedures are the only procedures apps may extend:
- `publicProcedure` — no auth
- `protectedProcedure` — valid session required
- `tenantProcedure` — session + active org required
- `adminProcedure` — session + `PLATFORM_ADMIN` required

### 6. Required Repo Conventions
- tRPC handler uses `fetchRequestHandler` (not `createNextApiHandler`)
- All four base procedures defined in `trpc.ts` — no ad-hoc procedure variants
- Admin sub-router is `packages/api/src/routers/admin/` — never `apps/admin/`
- No business logic in `createTRPCContext` — it only resolves session and provides `db`

### 7. Files / Directories to Create

```
packages/api/
  src/
    trpc.ts
    context.ts
    middleware/
      require-auth.ts
      require-tenant.ts
      require-role.ts
      require-platform-admin.ts
    routers/
      _app.ts
      admin/
        _admin.ts
    index.ts
  package.json                (add @trpc/server, zod, @pathfinder/auth, @pathfinder/db)

apps/web/app/api/trpc/[trpc]/route.ts
apps/dashboard/app/api/trpc/[trpc]/route.ts
apps/admin/app/api/trpc/[trpc]/route.ts
apps/web/lib/trpc.ts
apps/dashboard/lib/trpc.ts
apps/admin/lib/trpc.ts
```

### 8. Files / Directories NOT to Touch
- `packages/auth/` — already built
- `packages/db/` — already built
- Middleware files in `apps/` — those are Next.js middleware, not tRPC middleware

### 9. Data / Types / Interfaces Involved

```typescript
// context.ts
export type TRPCContext = {
  db: PrismaClient
  session: SessionContext
  headers: Headers
}

// trpc.ts
export const t = initTRPC.context<TRPCContext>().create({
  transformer: SuperJSON,
  errorFormatter({ shape, error }) { ... }
})

export const publicProcedure = t.procedure
export const protectedProcedure = t.procedure.use(requireAuth)
export const tenantProcedure = t.procedure.use(requireAuth).use(requireTenant)
export const adminProcedure = t.procedure.use(requireAuth).use(requirePlatformAdmin)
```

### 10. Step-by-Step Implementation Plan

**Step 1 — context.ts**  
`createTRPCContext` accepts `{ req: Request }`. Calls `resolveSession(req)` from `@pathfinder/auth`. Returns `{ db, session, headers: req.headers }`. **Important:** `resolveSession` must return a partial context (null userId, null activeTenantId) for unauthenticated requests — it must NOT throw on missing session. Only the `requireAuth` middleware throws `UNAUTHORIZED`. This is required so `publicProcedure` works for anonymous visitors in `apps/web`.

**Step 2 — trpc.ts**  
Initialize tRPC with `SuperJSON` transformer (handles `Date`, `Map`, `Set`). Define error formatter that strips stack traces from non-development responses.

**Step 3 — Middleware files**  
- `require-auth.ts`: checks `ctx.session.userId` is non-null, throws `UNAUTHORIZED`
- `require-tenant.ts`: checks `ctx.session.activeTenantId` is non-null, throws `UNAUTHORIZED`
- `require-role.ts`: exports `requireRole(minRole)` factory that returns middleware
- `require-platform-admin.ts`: checks `ctx.session.isPlatformAdmin`, throws `FORBIDDEN`

**Step 4 — Root router**  
Stub router with empty sub-routers. They will be populated in subsequent packets.

**Step 5 — Route handlers in apps**  
Each app's `app/api/trpc/[trpc]/route.ts`:
```typescript
import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { appRouter } from '@pathfinder/api'
import { createTRPCContext } from '@pathfinder/api'

const handler = (req: Request) => fetchRequestHandler({
  endpoint: '/api/trpc',
  req,
  router: appRouter,
  createContext: () => createTRPCContext({ req }),
})

export { handler as GET, handler as POST }
```

**Step 6 — Client lib files**  
Standard tRPC React Query client setup. Each app points to its own `/api/trpc` endpoint.

### 11. Acceptance Criteria
- `appRouter` exports from `packages/api` without TypeScript errors
- Calling a stub procedure via `curl` from each app returns a valid tRPC response
- `tsc --noEmit` passes in `packages/api` and all three apps
- `adminProcedure.query()` stub returns 403 when called without `PLATFORM_ADMIN` session (test manually)

### 12. Tests to Add or Run
- Unit test: `requireAuth` middleware throws `UNAUTHORIZED` for null session
- Unit test: `requireTenant` middleware throws `UNAUTHORIZED` for null `activeTenantId`
- Unit test: `requirePlatformAdmin` middleware throws `FORBIDDEN` for non-admin session

### 13. Edge Cases to Handle
- `SuperJSON` transformer must be installed in both client and server — version must match
- `createTRPCContext` called from Next.js server components vs. route handlers has different `req` shapes — use `Request` type consistently

### 14. Common Failure Modes
- Missing `SuperJSON` on the client tRPC setup causes date serialization failures
- Using `createNextApiHandler` (Pages Router API) instead of `fetchRequestHandler` (App Router)
- `requireRole` middleware not exported as a factory — it needs to accept the minimum role as a parameter

### 15. Reviewer Checklist
- [ ] Four base procedures defined and exported
- [ ] `fetchRequestHandler` used (not `createNextApiHandler`)
- [ ] Error formatter removes stack traces in production
- [ ] Admin sub-router exists and is separate from tenant procedures
- [ ] `SuperJSON` in both client and server
- [ ] `tsc --noEmit` passes in all packages and apps

---

<!-- ============================================================ -->
## PACKET-10 — Clerk Webhook Handler (Membership Sync)
<!-- ============================================================ -->

### 1. Goal
Implement the Clerk webhook handler that keeps the platform's `TenantMembership` and `User` tables in sync with Clerk organization membership events.

### 2. Why This Task Exists Now
Tenant membership data must exist in the platform DB for permission checks and tenant queries. Clerk fires these events when users join or leave orgs. Without this handler, the DB is always stale.

### 3. Scope
- `apps/dashboard/app/api/webhooks/clerk/route.ts`
- `packages/db/src/helpers/membership-sync.ts` — sync logic (testable, isolated from HTTP handler)

### 4. Out of Scope
- Integration provider webhooks (PACKET-13)
- The `svix` package is used for signature verification — install it

### 5. Architectural Context
Clerk sends webhooks to this endpoint on: `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`, `organization.created`. The handler must verify the `Svix-Signature` header before processing. It returns `200` quickly — no async processing needed here (membership sync is fast).

### 6. Required Repo Conventions
- Signature verification before ANY database read
- Unverified requests return `401`
- Use `db.tenantMembership.upsert()` — idempotent, handles Clerk retries safely
- `TenantMembership.status = 'REMOVED'` on delete — never hard-delete
- `writeAuditLog()` for every membership change
- Handler returns `200` even for DB errors — log the error, don't fail (prevents Clerk retry loops on transient failures)

### 7. Files / Directories to Create

```
apps/dashboard/
  app/api/webhooks/clerk/route.ts

packages/db/
  src/helpers/
    membership-sync.ts
```

### 8. Files / Directories NOT to Touch
- `apps/web/` or `apps/admin/` — webhook only in dashboard app
- Migration files
- `packages/auth/`

### 9. Data / Types / Interfaces Involved

```typescript
// Clerk webhook event shapes (relevant subset)
type ClerkOrgMembershipCreatedEvent = {
  type: 'organizationMembership.created'
  data: {
    organization: { id: string }
    public_user_data: { user_id: string; first_name: string; last_name: string; email_addresses: [{email_address: string}] }
    role: string   // Clerk role string — must be mapped to TenantRole
  }
}
```

### 10. Step-by-Step Implementation Plan

**Step 1 — Route handler structure**
```typescript
export async function POST(req: Request) {
  // 1. Read raw body as text (needed for signature verification)
  const body = await req.text()
  // 2. Verify Svix signature
  const wh = new Webhook(env.CLERK_WEBHOOK_SECRET)
  let event: WebhookEvent
  try {
    event = wh.verify(body, headers) as WebhookEvent
  } catch {
    return new Response('Unauthorized', { status: 401 })
  }
  // 3. Process event
  try {
    await handleClerkEvent(event)
  } catch (err) {
    logger.error({ action: 'clerk.webhook.process_failed', error: err.message })
    // Return 200 to prevent Clerk retry loop on persistent DB errors
  }
  return new Response('OK', { status: 200 })
}
```

**Step 2 — membership-sync.ts**  
`handleClerkEvent(event)` dispatches to:
- `syncMembershipCreated(data)` — upserts `User`, upserts `TenantMembership` with `status: ACTIVE`
- `syncMembershipUpdated(data)` — updates role in `TenantMembership`
- `syncMembershipDeleted(data)` — sets `TenantMembership.status = 'REMOVED'`

**Step 3 — Clerk role mapping**
```typescript
function mapClerkRoleToTenantRole(clerkRole: string): TenantRole {
  if (clerkRole === 'org:admin') return 'OWNER'
  if (clerkRole === 'org:member') return 'MANAGER'
  return 'STAFF'
}
```
Document this mapping — it is the source of role assignment.

**Step 4 — Audit logging**  
Each sync function calls `writeAuditLog({ action: 'member.synced', ... })`.

### 11. Acceptance Criteria
- POST with invalid Svix signature returns `401`
- POST with valid `organizationMembership.created` event creates a `TenantMembership` row
- POST with `organizationMembership.deleted` event sets `status: 'REMOVED'` (does not delete the row)
- Duplicate events (Clerk retry) do not create duplicate rows (upsert idempotency)
- Handler returns `200` even when `handleClerkEvent` throws

### 12. Tests to Add or Run
- Integration test: `syncMembershipCreated` with valid data creates User + TenantMembership
- Integration test: calling it twice with same data does not create duplicates
- Integration test: `syncMembershipDeleted` sets status to REMOVED, does not delete row
- Unit test: `mapClerkRoleToTenantRole` maps all known Clerk roles correctly

### 13. Edge Cases to Handle
- Clerk may send `organizationMembership.created` before `organization.created` — ensure `Tenant` row existence check before membership creation. If tenant doesn't exist yet, skip the membership sync (log warning). The `organization.created` event will create the tenant, and subsequent membership events will re-sync.
- `public_user_data.email_addresses` is an array — use index 0 as the primary email

### 14. Common Failure Modes
- Reading the request body as JSON before Svix verification — Svix needs the raw text
- Hard-deleting `TenantMembership` rows — breaks audit trail and any historical FK references
- Not importing `env.CLERK_WEBHOOK_SECRET` from `@pathfinder/config` — hardcoding the secret name

### 15. Reviewer Checklist
- [ ] Raw body used for Svix verification (not parsed JSON)
- [ ] Invalid signature returns `401` and stops processing
- [ ] Upsert pattern used (not create) — idempotent
- [ ] Deletion sets `status: REMOVED` (does not delete row)
- [ ] `writeAuditLog()` called for each membership change
- [ ] Handler returns `200` even on internal errors
- [ ] Clerk role → TenantRole mapping is documented and tested

---

<!-- ============================================================ -->
## PACKET-11 — Prisma Schema: Migration 003 (Venue Domain)
<!-- ============================================================ -->

### 1. Goal
Add the core PathFinder venue domain tables: `Venue`, `Place` (points of interest), `VisitorSession`, `Message`, and `DataAdapter`. Register tenanted tables in the isolation middleware.

### 2. Why This Task Exists Now
The chat router (PACKET-13) reads `Venue` and `Place` to answer visitor questions. The venue management routers (PACKET-12) write to these tables. Both depend on this migration.

### 3. Scope
- Add five models to `schema.prisma`
- New migration: `003_venue_domain`
- Update `packages/db/src/tenanted-tables.ts` to include the new tenanted tables
- Update `packages/db/src/index.ts` to export new types

### 4. Out of Scope
- tRPC procedures (PACKET-12, PACKET-13)
- Seeding demo data — that is a manual developer task using `prisma/seed.ts`
- Analytics events table (post-MVP)

### 5. Architectural Context
`Venue` belongs to a `Tenant` (one business can have multiple venues — e.g., a zoo with separate sections). `Place` is a point of interest within a `Venue`. `VisitorSession` tracks an anonymous visitor's chat session at a venue. `Message` stores individual chat turns. `DataAdapter` records how a venue's POI data was loaded (static JSON, future API, etc.) and enables future data source integrations without schema changes.

All five tables carry `tenantId` for isolation, even though visitor sessions and messages are written by anonymous users — carrying the `tenantId` allows the dashboard to query them later without bypass.

### 6. Required Repo Conventions
- All five models added to `TENANTED_TABLES` in `tenanted-tables.ts`
- `Place.type` is a plain string (not an enum) to keep it flexible for different venue categories
- `Place` importance scoring is optional — defaults to 0
- `VisitorSession.anonymousToken` is a client-generated UUID — no auth, no FK to `User`
- `Message.role` must be either `'user'` or `'assistant'` — use a Prisma enum
- `DataAdapter.adapterType` is a string matching the registry: `static_json`, `csv_import` (future: `live_api`)

### 7. Files / Directories to Modify

```
packages/db/
  prisma/
    schema.prisma                (add 5 models + 1 enum)
    migrations/003_venue_domain/migration.sql
  src/
    tenanted-tables.ts           (add 5 new table names)
    index.ts                     (export new types)
```

### 8. Files / Directories NOT to Touch
- Previous migration files
- `packages/db/src/middleware/tenant-isolation.ts` — only `tenanted-tables.ts` changes

### 9. Data / Types / Interfaces Involved

```prisma
model Venue {
  id               String    @id @default(cuid())
  tenantId         String
  name             String
  slug             String
  description      String?
  category         String?                        // e.g., "zoo", "botanical_garden"
  defaultCenterLat Float?
  defaultCenterLng Float?
  geoBoundary      Json?                          // GeoJSON polygon, optional
  isActive         Boolean   @default(true)
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt
  tenant           Tenant    @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  places           Place[]
  sessions         VisitorSession[]
  adapters         DataAdapter[]

  @@unique([tenantId, slug])
  @@index([tenantId])
}

model Place {
  id               String   @id @default(cuid())
  tenantId         String
  venueId          String
  name             String
  type             String                         // e.g., "attraction", "amenity", "restroom", "food", "seating"
  shortDescription String?
  longDescription  String?
  lat              Float
  lng              Float
  tags             String[]
  importanceScore  Int      @default(0)
  areaName         String?
  hours            String?
  isActive         Boolean  @default(true)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  venue            Venue    @relation(fields: [venueId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@index([venueId])
}

model VisitorSession {
  id             String    @id @default(cuid())
  tenantId       String
  venueId        String
  anonymousToken String    @unique                // client-generated UUID
  latestLat      Float?
  latestLng      Float?
  startedAt      DateTime  @default(now())
  lastActiveAt   DateTime  @default(now())
  venue          Venue     @relation(fields: [venueId], references: [id], onDelete: Restrict)
  messages       Message[]

  @@index([tenantId])
  @@index([venueId])
  @@index([anonymousToken])
}

model Message {
  id        String      @id @default(cuid())
  tenantId  String
  sessionId String
  role      MessageRole
  content   String
  createdAt DateTime    @default(now())
  session   VisitorSession @relation(fields: [sessionId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@index([sessionId])
}

model DataAdapter {
  id          String   @id @default(cuid())
  tenantId    String
  venueId     String
  adapterType String                             // "static_json" | "csv_import" | future types
  configBlob  Json     @default("{}")
  lastSyncAt  DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  venue       Venue    @relation(fields: [venueId], references: [id], onDelete: Restrict)

  @@index([tenantId])
  @@index([venueId])
}

enum MessageRole { user assistant }
```

### 10. Step-by-Step Implementation Plan

**Step 1** — Add all five models and the `MessageRole` enum to `schema.prisma`  
**Step 2** — Run `pnpm prisma migrate dev --name 003_venue_domain`  
**Step 3** — Update `tenanted-tables.ts`: add `'Venue'`, `'Place'`, `'VisitorSession'`, `'Message'`, `'DataAdapter'`  
**Step 4** — Update `index.ts` to export all new types  
**Step 5** — Run existing tenant isolation tests — they must still pass  

### 11. Acceptance Criteria
- Migration runs on a fresh DB
- Tenant isolation tests still pass (no regression)
- `db.venue.findMany({})` (no tenantId) throws `TenantIsolationError`
- `db.place.findMany({ where: { tenantId: 'org_1' } })` does not throw
- All new types exported from `@pathfinder/db`

### 12. Tests to Add or Run
- Extend existing tenant isolation tests: add one case each for `Venue` and `Place`

### 13. Edge Cases to Handle
- `Venue.@@unique([tenantId, slug])` — same slug is allowed across different tenants
- `Place.tags` is a `String[]` — Prisma handles this as a Postgres text array; ensure migration SQL uses `text[]`
- `VisitorSession.anonymousToken` is client-supplied — do not trust it for security decisions, only for session lookup

### 14. Common Failure Modes
- Forgetting to update `tenanted-tables.ts` — new tables will not be isolation-checked
- Using an enum for `Place.type` — too restrictive; different venue categories use different POI type vocabularies
- Adding `@relation` without specifying `onDelete` — defaults vary by Prisma version

### 15. Reviewer Checklist
- [ ] All five tables in `TENANTED_TABLES`
- [ ] `Venue` has `@@unique([tenantId, slug])`
- [ ] All FKs have explicit `onDelete: Restrict`
- [ ] `Place.tags` is `String[]` (not JSON)
- [ ] `MessageRole` enum has exactly two values: `user` and `assistant`
- [ ] Existing isolation tests still pass
- [ ] Migration runs on a fresh database

---

<!-- ============================================================ -->
## PACKET-12 — Venue and POI Management Routers
<!-- ============================================================ -->

### 1. Goal
Implement tRPC routers for managing venues and points of interest. These are the procedures the dashboard uses to set up and configure venue data.

### 2. Why This Task Exists Now
The dashboard (PACKET-15) needs these procedures to exist before building the UI. The chat router (PACKET-13) reads from the same tables these procedures write to.

### 3. Scope
- `packages/api/src/routers/venue.ts` — venue CRUD
- `packages/api/src/routers/venue.test.ts`
- `packages/api/src/routers/place.ts` — POI CRUD
- `packages/api/src/routers/place.test.ts`
- Wire both routers into `packages/api/src/routers/_app.ts`

### 4. Out of Scope
- DataAdapter management (post-MVP tooling — static JSON seeding is manual for now)
- Dashboard UI (PACKET-15)
- The public chat procedures (PACKET-13)
- Image upload for places (post-MVP)

### 5. Architectural Context
Every procedure follows: `tenantProcedure` → `requireRole(minRole)` → validate input → optional resource ownership check → business logic. Venue and place data is read by the public chat layer (via `publicProcedure`) — but CRUD is gated to authenticated tenant staff. Public reads happen in PACKET-13, not here.

### 6. Required Repo Conventions
- Use `tenantProcedure` for all procedures
- Zod schemas defined in the same file as the router
- Use `select` on all queries — never return `configBlob` from `DataAdapter`, `geoBoundary` from `Venue` in list views
- `requireRole` is called before any DB query in mutations
- Errors: `TRPCError` with `NOT_FOUND`, `FORBIDDEN`, `BAD_REQUEST`

### 7. Files / Directories to Create or Modify

```
packages/api/
  src/
    routers/
      venue.ts
      venue.test.ts
      place.ts
      place.test.ts
    routers/_app.ts              (add venue and place routers)
```

### 8. Files / Directories NOT to Touch
- `packages/db/` — no schema changes
- `apps/` — no UI in this packet

### 9. Data / Types / Interfaces Involved

**venue router procedures:**

| Procedure | Auth | Min Role | Notes |
|-----------|------|----------|-------|
| `venue.list` | `tenantProcedure` | STAFF | Returns all venues for active tenant |
| `venue.getById` | `tenantProcedure` | STAFF | Includes place count |
| `venue.create` | `tenantProcedure` | OWNER | Slug auto-generated from name if not provided |
| `venue.update` | `tenantProcedure` | MANAGER | Name, description, coordinates, isActive |
| `venue.delete` | `tenantProcedure` | OWNER | Hard delete only if venue has no places |

**place router procedures:**

| Procedure | Auth | Min Role | Notes |
|-----------|------|----------|-------|
| `place.list` | `tenantProcedure` | STAFF | `{ venueId }` — returns all places for a venue |
| `place.getById` | `tenantProcedure` | STAFF | Full place detail |
| `place.create` | `tenantProcedure` | MANAGER | Validates venueId belongs to tenant |
| `place.update` | `tenantProcedure` | MANAGER | Any place field except tenantId/venueId |
| `place.delete` | `tenantProcedure` | OWNER | Hard delete |
| `place.bulkCreate` | `tenantProcedure` | MANAGER | `{ venueId, places: PlaceInput[] }` — for loading static data |

**place.create input:**
```typescript
z.object({
  venueId: z.string().cuid(),
  name: z.string().min(1).max(200),
  type: z.string().min(1),
  shortDescription: z.string().max(500).optional(),
  longDescription: z.string().max(2000).optional(),
  lat: z.number(),
  lng: z.number(),
  tags: z.array(z.string()).default([]),
  importanceScore: z.number().int().min(0).max(100).default(0),
  areaName: z.string().max(200).optional(),
  hours: z.string().max(200).optional(),
}).strict()
```

### 10. Step-by-Step Implementation Plan

**Step 1 — venue.ts**  
Implement all five venue procedures. Slug generation utility: `slugify(name)` — lowercase, replace spaces with hyphens, strip non-alphanumeric. Check `@@unique([tenantId, slug])` constraint — throw `BAD_REQUEST` with message "A venue with this slug already exists" if violated.

**Step 2 — place.ts**  
Implement all six place procedures. `place.list` must verify the venueId belongs to the requesting tenant before returning results. `place.bulkCreate` wraps all creates in a Prisma transaction (`db.$transaction`). Limit bulk create to 500 places maximum — throw `BAD_REQUEST` if exceeded.

**Step 3 — Wire into _app.ts**
```typescript
venue: venueRouter,
place: placeRouter,
```

**Step 4 — Tests**  
For each router: at minimum one success case and one `FORBIDDEN` case per mutation, one `NOT_FOUND` case for getById with wrong tenant.

### 11. Acceptance Criteria
- `venue.create` with OWNER role creates a venue with auto-generated slug
- `venue.create` called with MANAGER role throws `FORBIDDEN`
- `place.create` with a `venueId` from a different tenant throws `NOT_FOUND`
- `place.bulkCreate` with 501 places throws `BAD_REQUEST`
- `place.list` returns all places for the specified venue
- `tsc --noEmit` passes in `packages/api`

### 12. Tests to Add or Run
- `venue.create` success + FORBIDDEN (MANAGER role)
- `venue.update` success + NOT_FOUND (wrong tenant)
- `place.create` success + NOT_FOUND (wrong tenant venueId)
- `place.bulkCreate` success + BAD_REQUEST (over limit)
- `place.list` returns empty array for venue with no places

### 13. Edge Cases to Handle
- Slug collision: if auto-generated slug already exists for this tenant, append `-2`, `-3`, etc.
- `venue.delete` with places attached: throw `BAD_REQUEST("Remove all POIs before deleting a venue")`
- `place.update` with `lat`/`lng` of `0` — zero is a valid coordinate, not falsy

### 14. Common Failure Modes
- Using `protectedProcedure` instead of `tenantProcedure` — auth without tenant scoping
- Not checking that `venueId` in `place.create` belongs to the active tenant — cross-tenant POI injection
- `place.bulkCreate` not wrapped in a transaction — partial loads on failure

### 15. Reviewer Checklist
- [ ] All procedures use `tenantProcedure`
- [ ] `requireRole` is first line of every mutation
- [ ] `place.create` and `place.list` verify `venueId` belongs to tenant
- [ ] `place.bulkCreate` uses `db.$transaction`
- [ ] `select` used on all queries — `geoBoundary` excluded from list views
- [ ] Slug collision handled
- [ ] FORBIDDEN test exists for all mutations
- [ ] Both routers wired into `_app.ts`

---

<!-- ============================================================ -->
## PACKET-13 — Chat Router and Location Intelligence
<!-- ============================================================ -->

### 1. Goal
Implement the core product: the location-aware chat router that uses the visitor's coordinates and venue POI data to answer questions through the Claude API. This is what the visitor experiences.

### 2. Why This Task Exists Now
This is the central value proposition of PathFinder. Everything built so far is infrastructure for this. The public web UI (PACKET-14) calls these procedures directly.

### 3. Scope
- `packages/api/src/lib/geo.ts` — Haversine distance + nearest POI finder
- `packages/api/src/lib/venue-context.ts` — system prompt builder
- `packages/api/src/routers/chat.ts` — two public procedures: `chat.session` and `chat.send`
- `packages/api/src/routers/chat.test.ts`
- Wire chat router into `_app.ts`
- Add `ANTHROPIC_API_KEY` to `packages/config/src/env.ts`
- Add `@anthropic-ai/sdk` dependency to `packages/api/package.json`

### 4. Out of Scope
- Streaming responses (useful post-MVP — the first version returns a complete response)
- Conversation history beyond the current session (history is loaded from DB but capped at last 10 messages)
- PostHog analytics (post-MVP)
- Dashboard session analytics UI (post-MVP)

### 5. Architectural Context
Both chat procedures are `publicProcedure` — no authentication required. The visitor supplies a `venueId` (from the URL they scanned) and an `anonymousToken` (UUID generated by the client on first visit and stored in `localStorage`). Session creation is idempotent by `anonymousToken`.

The chat flow for `chat.send`:
1. Validate the `venueId` exists and is active
2. Upsert the `VisitorSession` by `anonymousToken`
3. Update `latestLat`/`latestLng` on the session
4. Load all active `Place` records for the venue
5. Compute nearest POIs to the visitor's coordinates using `findNearestPlaces()`
6. Build the system prompt using `buildVenueContext()`
7. Load the last 10 messages from this session as conversation history
8. Call Claude API with system prompt + history + new user message
9. Save the user message and assistant response to `Message` table
10. Return the assistant's text response

The model to use: `claude-haiku-4-5-20251001` — optimized for fast, low-cost responses. The system prompt must not expose internal fields like `importanceScore` or `tenantId` to the LLM response.

### 6. Required Repo Conventions
- `venueId` from public input validated against DB — never trusted raw
- `anonymousToken` is used for session lookup only — it carries no permissions
- Claude API call uses prompt caching on the system prompt (venue data changes infrequently)
- The `Anthropic` client is instantiated once per module, not per request
- `chat.send` must not throw to the caller on Claude API failure — return a graceful fallback message and log the error
- `packages/api` is the only package that imports `@anthropic-ai/sdk`

### 7. Files / Directories to Create or Modify

```
packages/api/
  src/
    lib/
      geo.ts
      venue-context.ts
    routers/
      chat.ts
      chat.test.ts
    routers/_app.ts          (add chat router)
  package.json               (add @anthropic-ai/sdk)

packages/config/
  src/env.ts                 (add ANTHROPIC_API_KEY)
  .env.example               (add ANTHROPIC_API_KEY=)
```

### 8. Files / Directories NOT to Touch
- `packages/db/` — no schema changes
- `apps/` — no UI in this packet

### 9. Data / Types / Interfaces Involved

**geo.ts:**
```typescript
export function haversineDistanceMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number

export function findNearestPlaces(
  userLat: number,
  userLng: number,
  places: Array<{ id: string; lat: number; lng: number; [key: string]: unknown }>,
  limit: number
): Array<typeof places[number] & { distanceMeters: number }>
```

**venue-context.ts:**
```typescript
export function buildVenueSystemPrompt(params: {
  venue: { name: string; description: string | null; category: string | null }
  nearestPlaces: Array<{
    name: string
    type: string
    shortDescription: string | null
    distanceMeters: number
    areaName: string | null
    tags: string[]
    hours: string | null
  }>
  allPlaces: Array<{ name: string; type: string; shortDescription: string | null; tags: string[] }>
  userLat: number
  userLng: number
}): string
```

**chat router procedures:**

| Procedure | Auth | Input | Returns |
|-----------|------|-------|---------|
| `chat.session` | `publicProcedure` | `{ venueId, anonymousToken, lat?, lng? }` | `{ sessionId }` |
| `chat.send` | `publicProcedure` | `{ venueId, anonymousToken, message, lat, lng }` | `{ response: string, sessionId: string }` |

**chat.send input:**
```typescript
z.object({
  venueId: z.string().cuid(),
  anonymousToken: z.string().uuid(),
  message: z.string().min(1).max(1000),
  lat: z.number(),
  lng: z.number(),
}).strict()
```

### 10. Step-by-Step Implementation Plan

**Step 1 — geo.ts**  
Implement `haversineDistanceMeters` using the standard formula. Implement `findNearestPlaces` — sort by distance ascending, return the top `limit` with `distanceMeters` attached.

**Step 2 — venue-context.ts**  
`buildVenueSystemPrompt` returns a string formatted as:

```
You are Path Finder, a helpful on-site guide for {venue.name}.

About this venue:
{venue.description or "A venue with many things to explore."}

The visitor is currently at coordinates ({userLat}, {userLng}).

NEAREST PLACES (sorted by distance):
1. {name} ({type}) — {distanceMeters}m away{areaName ? " in "+areaName : ""}
   {shortDescription}
   Tags: {tags.join(", ")}
   Hours: {hours or "not specified"}
...

ALL PLACES AT THIS VENUE:
[brief list of name + type for all places, for context]

Rules:
- Ground every answer in the venue data above. Do not invent places or distances.
- Always mention proximity when relevant ("You're about 50 meters from...").
- Be concise. Visitors are on foot and reading on a phone.
- For practical questions (bathroom, food, seating), prioritize the nearest match.
- For exploratory questions, suggest the nearest high-importance option.
- Never reveal internal data like scores or IDs.
```

**Step 3 — chat.ts: `chat.session`**  
Upsert `VisitorSession` by `anonymousToken` using `db.visitorSession.upsert`. Update `latestLat`/`latestLng` if provided. Return `{ sessionId }`.

**Step 4 — chat.ts: `chat.send`**
```typescript
chat.send: publicProcedure
  .input(sendMessageSchema)
  .mutation(async ({ ctx, input }) => {
    // 1. Validate venue
    const venue = await ctx.db.venue.findFirst({
      where: { id: input.venueId, isActive: true },
      select: { id: true, tenantId: true, name: true, description: true, category: true }
    })
    if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

    // 2. Upsert session, update location
    const session = await ctx.db.visitorSession.upsert({
      where: { anonymousToken: input.anonymousToken },
      create: { tenantId: venue.tenantId, venueId: input.venueId, anonymousToken: input.anonymousToken, latestLat: input.lat, latestLng: input.lng, lastActiveAt: new Date() },
      update: { latestLat: input.lat, latestLng: input.lng, lastActiveAt: new Date() },
      select: { id: true },
    })

    // 3. Load places and history
    const [places, history] = await Promise.all([
      ctx.db.place.findMany({
        where: { venueId: input.venueId, tenantId: venue.tenantId, isActive: true },
        select: { id: true, name: true, type: true, shortDescription: true, lat: true, lng: true, tags: true, areaName: true, hours: true, importanceScore: true },
      }),
      ctx.db.message.findMany({
        where: { sessionId: session.id, tenantId: venue.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { role: true, content: true },
      }),
    ])

    // 4. Build context
    const nearestPlaces = findNearestPlaces(input.lat, input.lng, places, 8)
    const systemPrompt = buildVenueSystemPrompt({ venue, nearestPlaces, allPlaces: places, userLat: input.lat, userLng: input.lng })

    // 5. Call Claude
    let assistantResponse: string
    try {
      const anthropic = getAnthropicClient()  // module-level singleton
      const result = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [
          ...history.reverse().map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
          { role: 'user', content: input.message },
        ],
      })
      assistantResponse = result.content[0]?.type === 'text' ? result.content[0].text : "I'm sorry, I couldn't generate a response."
    } catch (err) {
      logger.error({ action: 'chat.send.claude_failed', venueId: input.venueId, error: (err as Error).message })
      assistantResponse = "I'm having trouble right now. Please try again in a moment."
    }

    // 6. Persist messages
    await ctx.db.$transaction([
      ctx.db.message.create({ data: { tenantId: venue.tenantId, sessionId: session.id, role: 'user', content: input.message } }),
      ctx.db.message.create({ data: { tenantId: venue.tenantId, sessionId: session.id, role: 'assistant', content: assistantResponse } }),
    ])

    return { response: assistantResponse, sessionId: session.id }
  })
```

**Step 5 — Wire into _app.ts**

**Step 6 — Update env.ts**  
Add `ANTHROPIC_API_KEY: z.string().min(1)` to the Zod schema. Add to `.env.example`.

### 11. Acceptance Criteria
- `chat.send` with a valid `venueId` and coordinates returns a non-empty string response
- `chat.send` with a non-existent `venueId` throws `NOT_FOUND`
- Calling `chat.send` twice with the same `anonymousToken` uses the same session (no duplicate sessions)
- Messages are persisted to the `Message` table after each `chat.send`
- Claude API failure returns a graceful fallback string — does not throw `TRPCError`
- `findNearestPlaces` returns places sorted by ascending distance
- `tsc --noEmit` passes

### 12. Tests to Add or Run
- Unit: `haversineDistanceMeters` — known coordinates with known expected distance
- Unit: `findNearestPlaces` — 5 places at known distances, returns correct top-N sorted
- Unit: `buildVenueSystemPrompt` — returns a string containing the venue name and nearest place name
- Integration: `chat.send` with mocked Anthropic client — verifies messages are saved to DB
- Unit: `chat.send` Claude failure → returns fallback string, does not throw

### 13. Edge Cases to Handle
- `places` array is empty (venue exists but no POIs loaded yet) — system prompt should say "No specific points of interest have been configured yet" and still answer general questions gracefully
- `history` reversed — DB returns newest first, Claude needs oldest first
- User message over 1000 characters — Zod rejects at input validation (do not truncate silently)
- `importanceScore` on `Place` must NOT appear in the system prompt — it is an internal field

### 14. Common Failure Modes
- Sending `importanceScore` or `tenantId` to the LLM in the system prompt — leaks internal data
- Instantiating `new Anthropic()` inside the mutation — creates a new client per request
- Not reversing `history` before sending to Claude — conversation order is wrong
- Not caching the system prompt — loses the cost benefit on repeated questions

### 15. Reviewer Checklist
- [ ] `chat.send` and `chat.session` both use `publicProcedure`
- [ ] `venueId` validated against DB — not trusted raw
- [ ] `anonymousToken` carries no permissions — only used for session lookup
- [ ] `importanceScore` and `tenantId` excluded from LLM prompt
- [ ] Anthropic client is a module-level singleton
- [ ] System prompt uses `cache_control: { type: 'ephemeral' }` on the system message
- [ ] Claude failure returns fallback string, does not throw
- [ ] Messages saved to DB in a transaction
- [ ] History loaded in correct chronological order before sending to Claude
- [ ] `ANTHROPIC_API_KEY` added to `env.ts` and `.env.example`

---

<!-- ============================================================ -->
## PACKET-14 — Public Web App: Mobile Chatbot PWA
<!-- ============================================================ -->

### 1. Goal
Build the visitor-facing mobile-first chatbot app (`apps/web`). A visitor scans a QR code, the app requests location permission, and they can immediately start asking questions about where they are and what to do.

### 2. Why This Task Exists Now
This is the user-facing product. The chat router (PACKET-13) is the backend. This packet builds the UI that visitors use. This is the first thing a real person will actually touch.

### 3. Scope
- `apps/web/app/[venueSlug]/page.tsx` — venue landing page (redirects to chat)
- `apps/web/app/[venueSlug]/chat/page.tsx` — main chat page (the product)
- `apps/web/components/ChatWindow.tsx` — scrollable message list + input bar
- `apps/web/components/MessageBubble.tsx` — individual message rendering
- `apps/web/components/QuickPromptChips.tsx` — starter prompt buttons
- `apps/web/components/LocationBanner.tsx` — location permission prompt + status
- `apps/web/hooks/useGeolocation.ts` — browser geolocation hook
- `apps/web/hooks/useSession.ts` — anonymous token management (localStorage)
- `apps/web/app/[venueSlug]/chat/layout.tsx` — sets viewport meta for mobile
- `apps/web/public/manifest.json` — PWA manifest

### 4. Out of Scope
- Streaming responses — complete response only in MVP
- Map UI — explicitly deferred
- Conversation history persistence across page refreshes (history is loaded from DB via `chat.session` on mount)
- Rate limiting (noted as TODO)
- Any authentication or user accounts
- Analytics dashboard

### 5. Architectural Context
`apps/web` has NO Clerk provider and NO auth middleware. Every visitor is anonymous. The `anonymousToken` is a UUID stored in `localStorage` — generated on first visit, persisted across sessions at the same venue. `venueSlug` in the URL is used to look up the venue (via a `venue.getBySlug` public procedure added in this packet).

The chat page is a client component (`'use client'`) — it uses browser APIs (geolocation, localStorage) and tRPC mutations. The venue landing page is a server component for fast initial load.

Mobile-first design requirements:
- Input bar pinned to the bottom of the viewport
- Message list scrollable, auto-scrolls to latest message
- Quick prompt chips visible before first message
- Font size minimum 16px to prevent iOS zoom on focus
- Tap targets minimum 44px

### 6. Required Repo Conventions
- `apps/web` does NOT import `@clerk/nextjs` — remove Clerk from `apps/web/package.json` if it was added in PACKET-03
- `apps/web/middleware.ts` passes all requests through without auth checks
- No tRPC `protectedProcedure` or `tenantProcedure` called from `apps/web` — only `publicProcedure`
- `next/link` for navigation — not `<a>`
- PWA manifest is minimal but valid — name, short_name, display, icons

### 7. Files / Directories to Create or Modify

```
apps/web/
  app/
    [venueSlug]/
      page.tsx                        (server component: load venue, redirect to /chat)
      chat/
        layout.tsx                    (mobile viewport meta)
        page.tsx                      ('use client' — the chat interface)
    not-found.tsx
    layout.tsx                        (remove ClerkProvider if present from PACKET-03)
  components/
    ChatWindow.tsx
    MessageBubble.tsx
    QuickPromptChips.tsx
    LocationBanner.tsx
  hooks/
    useGeolocation.ts
    useSession.ts
  public/
    manifest.json
  middleware.ts                       (passthrough — no auth)
  package.json                        (remove @clerk/nextjs if present)
```

**Add to `packages/api/src/routers/venue.ts`** (a minimal public read — do not add to `place.ts`):
```typescript
venue.getBySlug: publicProcedure
  .input(z.object({ slug: z.string() }))
  .query(async ({ ctx, input }) => {
    const venue = await ctx.db.venue.findFirst({
      where: { slug: input.slug, isActive: true },
      select: { id: true, name: true, description: true, category: true },
    })
    if (!venue) throw new TRPCError({ code: 'NOT_FOUND' })
    return venue
  })
```

### 8. Files / Directories NOT to Touch
- `apps/dashboard/` or `apps/admin/`
- `packages/api/src/routers/chat.ts` — already built in PACKET-13

### 9. Data / Types / Interfaces Involved

**useGeolocation hook:**
```typescript
export function useGeolocation(): {
  lat: number | null
  lng: number | null
  error: string | null
  permission: 'granted' | 'denied' | 'prompt' | 'loading'
  refresh: () => void
}
```

**useSession hook:**
```typescript
export function useSession(venueId: string): {
  anonymousToken: string   // UUID, generated once per venueId and stored in localStorage
  sessionId: string | null // set after first chat.send response
  setSessionId: (id: string) => void
}
```

**ChatWindow props:**
```typescript
type Message = { role: 'user' | 'assistant'; content: string }
type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  isLoading: boolean
  venueId: string
  anonymousToken: string
  lat: number | null
  lng: number | null
}
```

### 10. Step-by-Step Implementation Plan

**Step 1 — useGeolocation.ts**  
Use `navigator.geolocation.watchPosition` with a 10-second timeout. Update coordinates on each successful position event. Set `error` on permission denied. Export `permission` state for the location banner.

**Step 2 — useSession.ts**  
On first call for a given `venueId`, generate `crypto.randomUUID()`, store as `pathfinder_token_{venueId}` in localStorage. Return the stored value on subsequent calls.

**Step 3 — [venueSlug]/page.tsx (server component)**  
Fetch venue by slug using a server-side tRPC caller. If not found: `notFound()`. If found: render a brief loading/welcome screen and redirect to `/[venueSlug]/chat` using `<meta http-equiv="refresh">` or Next.js `redirect()`.

**Step 4 — chat/page.tsx (client component)**  
Main chat interface:
- On mount: call `chat.session` with `anonymousToken`, `venueId`, `lat`, `lng`
- Render `<LocationBanner>` if location not yet granted
- Render `<QuickPromptChips>` if no messages yet
- Render `<ChatWindow>` with messages
- On send: call `chat.send` mutation, append response to message list

**Step 5 — ChatWindow.tsx**  
Scrollable container. `useEffect` to scroll to bottom when messages change. Input bar at bottom with send button. Disabled while `isLoading`. Minimum input font-size 16px.

**Step 6 — MessageBubble.tsx**  
User messages right-aligned, assistant messages left-aligned. Assistant messages support basic markdown rendering (bold, line breaks) — use a lightweight renderer or just `white-space: pre-wrap`.

**Step 7 — QuickPromptChips.tsx**  
Three chips: "What am I near?", "What should I do next?", "Where is the nearest bathroom?" — clicking a chip calls `onSend` with the chip text.

**Step 8 — LocationBanner.tsx**  
If permission is `'prompt'`: show "Allow location for better answers" with a button to trigger geolocation. If `'denied'`: show "Location denied — answers may be less precise." If `'granted'`: show nothing (or a small indicator).

**Step 9 — manifest.json**
```json
{
  "name": "Path Finder",
  "short_name": "PathFinder",
  "display": "standalone",
  "start_url": "/",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [{ "src": "/icon.png", "sizes": "192x192", "type": "image/png" }]
}
```
Add a placeholder `icon.png` (a simple 192×192 PNG).

**Step 10 — Remove Clerk from apps/web**  
If `@clerk/nextjs` was added to `apps/web/package.json` in PACKET-03, remove it. Remove `<ClerkProvider>` from `apps/web/app/layout.tsx`. Update `middleware.ts` to a passthrough.

### 11. Acceptance Criteria
- Visiting `/[venueSlug]` for an active venue redirects to `/[venueSlug]/chat`
- Visiting `/nonexistent-slug` returns a 404 page
- The location permission banner appears before geolocation is granted
- After granting location, sending a message calls `chat.send` and displays the response
- The three quick prompt chips appear before the first message is sent
- Messages display in the correct user/assistant layout
- Input bar remains pinned to bottom while scrolling through messages
- The app is installable as a PWA (manifest.json linked in `<head>`)
- `tsc --noEmit` passes in `apps/web`

### 12. Tests to Add or Run
- Unit: `useGeolocation` sets `permission: 'denied'` when browser denies
- Unit: `useSession` returns the same token across multiple calls for the same venueId
- Unit: `QuickPromptChips` calls `onSend` with the correct text when clicked
- Manual: open on a real phone, allow location, send a message, verify response is venue-aware

### 13. Edge Cases to Handle
- Location not granted on first load — `lat`/`lng` will be null; `chat.send` still works (venue answers general questions without coordinates)
- `crypto.randomUUID()` — available in all modern browsers but check for HTTPS (required for geolocation too — note this in a comment)
- Auto-scroll: only scroll to bottom if the user is already near the bottom (do not force-scroll if they are reading older messages)
- Network error on `chat.send` — show an inline error message next to the failed user bubble, do not crash

### 14. Common Failure Modes
- Importing from `@clerk/nextjs` — must not exist in `apps/web`
- Using a server component for the chat page — browser APIs require `'use client'`
- Input font-size below 16px — iOS Safari auto-zooms on focus, breaking mobile layout
- Not calling `chat.session` on mount — session not initialized, `chat.send` creates a new session each time

### 15. Reviewer Checklist
- [ ] No `@clerk/nextjs` import in `apps/web`
- [ ] `apps/web/middleware.ts` has no auth enforcement
- [ ] Only `publicProcedure` called from `apps/web`
- [ ] Chat page is `'use client'`
- [ ] `useSession` persists token in localStorage per venueId
- [ ] `useGeolocation` uses `watchPosition` (not one-shot `getCurrentPosition`)
- [ ] Input font-size ≥ 16px
- [ ] Quick prompt chips visible before first message
- [ ] `manifest.json` linked in `<head>` via `<link rel="manifest">`
- [ ] `tsc --noEmit` passes

---

<!-- ============================================================ -->
## PACKET-15 — Dashboard: Minimal Venue Management UI
<!-- ============================================================ -->

### 1. Goal
Build the minimal dashboard for `apps/dashboard` so the platform owner (and eventually tenant staff) can create venues, enter POIs, and configure the data that powers the chatbot — without touching code or the database directly.

### 2. Why This Task Exists Now
The chatbot is only as good as the venue data behind it. This UI is the tool used to load that data. Without it, every new venue requires developer intervention to seed.

### 3. Scope
- `apps/dashboard/app/(app)/venues/page.tsx` — venue list
- `apps/dashboard/app/(app)/venues/new/page.tsx` — create venue form
- `apps/dashboard/app/(app)/venues/[venueId]/page.tsx` — venue detail + place list
- `apps/dashboard/app/(app)/venues/[venueId]/places/new/page.tsx` — add a place form
- `apps/dashboard/app/(app)/venues/[venueId]/places/[placeId]/edit/page.tsx` — edit a place
- Shared components: `VenueCard`, `PlaceRow`, `PlaceForm`, `VenueForm`

### 4. Out of Scope
- Analytics / session viewer (post-MVP)
- Bulk import UI (post-MVP — bulk create via `place.bulkCreate` is available in the API for developers)
- Team member management (post-MVP)
- DataAdapter configuration UI (post-MVP)

### 5. Architectural Context
`apps/dashboard` uses Clerk for auth. Tenant staff access their own venues only — the `tenantProcedure` on the backend enforces this. The dashboard reads `activeTenantId` from the Clerk JWT via the tRPC context. Dashboard pages are React Server Components where possible; forms are client components.

### 6. Required Repo Conventions
- Forms use `react-hook-form` with `zodResolver` — import Zod schemas from `@pathfinder/api`
- All data fetching via tRPC procedures — no direct `db` calls in app pages
- No permission logic in components — the backend enforces roles
- All navigation with `next/link` — not `<a>`
- Use `packages/ui` components for shared UI elements

### 7. Files / Directories to Create

```
apps/dashboard/
  app/
    (app)/
      venues/
        page.tsx                          (RSC: list venues)
        new/
          page.tsx                        ('use client': create venue form)
        [venueId]/
          page.tsx                        (RSC: venue detail + place list)
          places/
            new/
              page.tsx                    ('use client': add place form)
            [placeId]/
              edit/
                page.tsx                  ('use client': edit place form)
  components/
    VenueCard.tsx
    PlaceRow.tsx
    PlaceForm.tsx
    VenueForm.tsx
```

### 8. Files / Directories NOT to Touch
- `apps/web/` or `apps/admin/`
- `packages/api/` — all necessary procedures already exist from PACKET-12

### 9. Data / Types / Interfaces Involved
- `Venue` and `Place` types from `@pathfinder/db`
- `venue.*` and `place.*` tRPC procedures from PACKET-12
- Zod input schemas imported from `@pathfinder/api`

### 10. Step-by-Step Implementation Plan

**Step 1 — venues/page.tsx (RSC)**  
Call `venue.list` via server-side tRPC caller. Render a list of `<VenueCard>` components. Include a "New Venue" button linking to `/venues/new`. Empty state: "No venues yet — create your first one."

**Step 2 — venues/new/page.tsx (client component)**  
`VenueForm` with fields: name (required), description, category, defaultCenterLat, defaultCenterLng. On submit: call `venue.create` mutation. On success: redirect to `/venues/[venueId]`.

**Step 3 — venues/[venueId]/page.tsx (RSC)**  
Call `venue.getById` and `place.list` in parallel. Render venue name, description, coordinates. Render a table of places using `<PlaceRow>`. Include an "Add Place" button.

**Step 4 — places/new/page.tsx (client component)**  
`PlaceForm` with all place fields. On submit: call `place.create`. On success: redirect back to `/venues/[venueId]`.

**Step 5 — places/[placeId]/edit/page.tsx (client component)**  
Load place data, pre-populate `PlaceForm`. On submit: call `place.update`. On success: redirect to `/venues/[venueId]`.

**Step 6 — PlaceForm component**  
Fields: name, type (text input with suggestions: attraction, amenity, restroom, food, seating, exhibit, scenic_spot, entrance), shortDescription, lat, lng, tags (comma-separated input that splits to array), importanceScore (0–100 number input), areaName, hours, isActive (checkbox).

**Step 7 — VenueCard component**  
Shows venue name, category, place count, isActive status, and a link to the venue detail page.

**Step 8 — PlaceRow component**  
Table row showing: name, type, area, distance placeholder, isActive toggle. Each row has an Edit link.

### 11. Acceptance Criteria
- Authenticated tenant staff can view their venue list
- Creating a venue via the form creates a DB row and redirects to the venue detail page
- Venue detail page lists all places for that venue
- Adding a place via the form creates a DB row and redirects back to the venue detail
- Editing a place via the form updates the DB row
- All forms show validation errors using the tRPC Zod schema
- `tsc --noEmit` passes in `apps/dashboard`

### 12. Tests to Add or Run
- Manual: create a venue, add 3 places, verify they appear in the place list
- Manual: edit a place, verify the change persists
- Manual: the chatbot (PACKET-14) uses the places just entered to answer location-aware questions

### 13. Edge Cases to Handle
- Tenant with zero venues — render empty state, not an error
- `venue.create` slug collision — show the tRPC `BAD_REQUEST` error inline on the form
- `place.create` with invalid coordinates (NaN, out-of-range) — form validation catches this before submission
- `tags` field: empty string input should produce `[]` not `[""]`

### 14. Common Failure Modes
- Calling `db.*` directly from a page component — all data access must go through tRPC
- Redefining Zod schemas in the form instead of importing from `@pathfinder/api` — schema drift
- Rendering a form as an RSC — forms must be `'use client'`

### 15. Reviewer Checklist
- [ ] All data fetching via tRPC — no direct DB calls in app pages
- [ ] Forms are `'use client'`, list/detail pages are RSC
- [ ] Zod schemas imported from `@pathfinder/api` — not redefined
- [ ] `tags` comma-split produces correct `string[]`
- [ ] Empty states handled on all list pages
- [ ] All navigation uses `next/link`
- [ ] `tsc --noEmit` passes

---

*End of first 15 task packets.*

---

## A. Recommended Execution Order

Packets 01–09 are **strictly sequential** — each packet is a hard dependency of the next. Do not begin a packet until the previous one passes all acceptance criteria and CI is green.

```
PACKET-01 → PACKET-02 → PACKET-03 → PACKET-04
                                        ↓
                             PACKET-05 → PACKET-06 → PACKET-07
                                                         ↓
                                              PACKET-08 → PACKET-09
                                                              ↓
                                          PACKET-10 → PACKET-11
                                                           ↓
                                                      PACKET-12
                                                           ↓
                                                      PACKET-13
                                                           ↓
                                          PACKET-14 ← PACKET-13
                                               ↓
                                          PACKET-15
```

PACKET-10 (Clerk webhook) must come before PACKET-11 (venue schema) because the Clerk webhook handler syncs tenant membership — required for any authenticated dashboard access. PACKET-11 (venue domain schema) must precede PACKET-12 (venue routers) and PACKET-13 (chat router). PACKET-14 (public web app) depends on PACKET-13 (chat procedures). PACKET-15 (dashboard UI) depends on PACKET-12 (venue/place procedures).

**Milestone checkpoint after PACKET-09:** Auth works, tenant isolation is enforced, CI is green, tRPC routes exist. Human review required before continuing.

**Milestone checkpoint after PACKET-13:** The chat router is complete. At this point a developer can test the core product via `curl` or a tRPC playground before building any UI. Strongly recommended: seed a test venue manually via Prisma Studio, call `chat.send`, and verify the response is venue-aware.

**Demo-ready checkpoint after PACKET-14:** A real person can scan a QR code, allow location, and ask "What am I near?" Human review and real-device testing required before continuing to PACKET-15.

---

## B. Packets Safest to Delegate with Light Review

These packets have lower architectural risk. Codex output should be checked for convention adherence but the blast radius of a mistake is limited.

| Packet | Reason |
|--------|--------|
| PACKET-01 | Structural only — no logic |
| PACKET-02 | Config only — no business logic |
| PACKET-03 | Scaffolding — logic is minimal, errors are visible immediately |
| PACKET-04 | CI YAML — misconfiguration is caught by GitHub itself |
| PACKET-11 | Schema additions — follows an established migration pattern |
| PACKET-12 | Venue/POI CRUD — standard tenantProcedure pattern, no public exposure |
| PACKET-15 | Dashboard forms — authenticated, no public data path |

---

## C. Packets Requiring Stricter Review

These packets touch security-critical code or the core product value. Every line must be reviewed before merge.

| Packet | Why |
|--------|-----|
| PACKET-07 | Tenant isolation middleware — a bug here leaks cross-tenant data |
| PACKET-08 | Permission guards — a bug here bypasses role enforcement |
| PACKET-09 | tRPC context + procedure types — the base for all future auth; must handle anonymous visitors correctly |
| PACKET-10 | Clerk webhook — membership sync bugs corrupt access control |
| PACKET-13 | Core product — chat router is a `publicProcedure`, must validate venueId from DB; Claude prompt must not leak internal fields; session handling must be idempotent |
| PACKET-14 | First user-facing code — requires real-device testing; Clerk must be fully absent from `apps/web` |

**Reviewer protocol for these packets:**
1. Read the acceptance criteria independently before reviewing the code
2. Trace the cross-tenant data access scenario manually
3. Check that every listed `Reviewer Checklist` item is satisfied
4. Run the tests locally — do not accept CI alone

---

## D. Suggested Packet-to-Branch Strategy

Use one branch per packet. Name branches: `feat/packet-01-monorepo-init`, `feat/packet-07-tenant-isolation`, etc.

```
main
 └── feat/packet-01-monorepo-init        → PR → merge to main
      └── feat/packet-02-tooling-config  → PR → merge to main
           └── ...
```

**Rules:**
- Each packet branches from the latest `main` (after the previous packet merged)
- PRs are small — one packet per PR
- Do not batch multiple packets into one PR
- PRs for security-critical packets (07, 08, 09, 10) require explicit human approval before merge — do not auto-merge

---

## E. Reusable Codex Task Prompt Template

Use this template verbatim when handing a packet to Codex. Replace the `[PACKET-XX]` placeholder.

---

```
You are implementing a specific task for PathFinderOS, a multi-tenant SaaS platform.

Before writing any code, read these files in order:
1. /CLAUDE.md — engineering constitution and conventions
2. /docs/architecture.md — platform architecture decisions
3. /docs/implementation-plan.md — full implementation plan
4. /docs/codex-task-packets.md — find PACKET-[XX] and read it completely

Your task is: PACKET-[XX] — [PACKET TITLE]

Strict operating rules:
- Implement only what is listed in the "Scope" section of the packet
- Do not touch any files listed in "Files / Directories NOT to Touch"
- Do not introduce any pattern not established in CLAUDE.md
- If you encounter an ambiguity not covered by the packet or CLAUDE.md, stop and state the ambiguity — do not invent a solution
- Every acceptance criterion in the packet must be satisfied before you consider the task complete
- Run `pnpm turbo run typecheck` and `pnpm turbo run test` before reporting done — fix any errors

Do not proceed past the scope of this packet. Do not refactor code outside the stated files. Do not add features not listed.

Report when done: list each acceptance criterion and whether it passes.
```

---

*End of codex-task-packets.md*
