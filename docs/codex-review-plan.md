# PathFinderOS — Systematic Code Review Plan

> **Purpose:** Structured post-build review of all 15 packets. Each phase is self-contained and can be handed to Codex independently. Complete phases in order — later phases assume earlier ones pass.
>
> **Ground rules for every phase:**
> - Read the file(s) before touching anything.
> - If you find a violation of CLAUDE.md, fix it. If you find drift (a pattern that's wrong but not critical), note it in a comment at the bottom of the file with `// DRIFT:` prefix — do not fix drift in an unrelated phase.
> - Do not refactor working code. Fix bugs and constitution violations only.
> - After each phase, run `pnpm turbo run typecheck test` and confirm zero errors before marking done.

---

## Phase 1 — Tenant Isolation (Security Gate)

**Files to review:**
- `packages/db/src/tenanted-tables.ts`
- `packages/db/src/middleware/tenant-isolation.ts`
- `packages/db/src/middleware/tenant-isolation.test.ts`
- `packages/db/src/client.ts`

**What to check:**

1. **Tenanted table list is complete.** Cross-reference every model in `packages/db/prisma/schema.prisma` that has a `tenantId` field. Every such model must appear in `TENANTED_TABLES`. Missing entries = critical bug.

2. **Middleware is applied to the Prisma client.** In `client.ts`, confirm `tenantIsolationMiddleware` is registered via `db.$use(...)`. If it isn't wired in, the whole guard is dead.

3. **`upsert` branch covers both `where` and `create`.** Confirm the upsert check requires `tenantId` in both clauses (it should — verify it hasn't been softened).

4. **`createMany` path.** Confirm `createMany` data is an array and every item is checked (not just the first).

5. **Test coverage.** Run `pnpm turbo run test --filter=@pathfinder/db` and confirm all branches pass. The CI gate requires 100% branch coverage on the isolation middleware.

6. **`withTenantIsolationBypass` is only called from approved locations.** Grep the whole repo for `withTenantIsolationBypass`. It should appear in:
   - `packages/api/src/routers/venue.ts` — `getBySlug` (public slug lookup)
   - Nowhere else. Any other call site is a critical violation.

**Expected outcome:** No issues if packet 07 was implemented correctly. The main risk is that migration 003 added new tenanted models that weren't added to `TENANTED_TABLES`.

---

## Phase 2 — Auth Layer

**Files to review:**
- `packages/auth/src/session.ts`
- `packages/auth/src/permissions.ts`
- `packages/auth/src/session.test.ts`
- `packages/auth/src/permissions.test.ts`
- `packages/api/src/middleware/require-auth.ts`
- `packages/api/src/middleware/require-tenant.ts`
- `packages/api/src/middleware/require-role.ts`
- `packages/api/src/middleware/require-platform-admin.ts`
- `packages/api/src/trpc.ts`

**What to check:**

1. **`resolveSession` returns `null` for unauthenticated requests** — not throws. This is required for `publicProcedure` to work for anonymous visitors (chat). If it throws, the web app breaks.

2. **`isPlatformAdmin` uses strict equality.** In `session.ts`, confirm the check is `=== 'PLATFORM_ADMIN'`, not a truthy check.

3. **Role hierarchy uses numeric comparison.** In `permissions.ts`, `requireTenantRole` must compare roles numerically (OWNER > MANAGER > STAFF), not with string equality.

4. **`activeTenantId` comes from JWT only.** Confirm `activeTenantId` is sourced from `authState.orgId` (Clerk JWT claim) — not from any request parameter.

5. **Middleware chain on `tenantProcedure`.** In `trpc.ts`, confirm the order is: `requireAuth` → `requireTenant`. Not reversed.

6. **`adminProcedure` does not call `requireTenant`.** Admin procedures use `requirePlatformAdmin` — they bypass tenant scoping by design. Confirm there's no `requireTenant` in the admin middleware chain.

7. **`requireRole` is middleware, not inline.** In the routers, role checks should be `.use(requireRole('OWNER'))` before `.input(...)` — not manual checks inside the handler body.

8. **Tests for forbidden paths exist.** In `session.test.ts` and `permissions.test.ts`, confirm there are tests that verify unauthenticated and wrong-role cases return the correct error.

**Expected outcome:** `resolveSession` returning null for unauth is a known fix from packet 08 — verify it wasn't reverted. Role numeric comparison is the other common mistake.

---

## Phase 3 — tRPC Routers

**Files to review:**
- `packages/api/src/routers/venue.ts`
- `packages/api/src/routers/venue.test.ts`
- `packages/api/src/routers/place.ts`
- `packages/api/src/routers/place.test.ts`
- `packages/api/src/routers/chat.ts`
- `packages/api/src/routers/chat.test.ts`
- `packages/api/src/routers/_app.ts`
- `packages/api/src/routers/admin/_admin.ts`
- `packages/api/src/context.ts`

**What to check:**

1. **Every procedure uses the right base.** Map each procedure to its expected base:
   - `venue.getBySlug` → `publicProcedure` ✓ (slug lookup is public)
   - `venue.list`, `venue.getById`, `venue.create`, `venue.update`, `venue.delete` → `tenantProcedure`
   - `place.*` → `tenantProcedure`
   - `chat.session`, `chat.send` → `publicProcedure` (anonymous visitors)
   - Any admin procedures → `adminProcedure`

2. **Role gates on mutations.** Check:
   - `venue.create` → `requireRole('OWNER')`
   - `venue.update` → `requireRole('MANAGER')` or higher
   - `venue.delete` → `requireRole('OWNER')`
   - `place.create` → `requireRole('MANAGER')` or higher
   - `place.delete` → `requireRole('OWNER')`
   - Reads (`list`, `getById`) → no role gate (any authenticated tenant member)

3. **All inputs validated with Zod `.input()`.** No procedure may read from `ctx.input` or `input` without a Zod schema.

4. **No `throw new Error(...)` in procedures.** All throws must be `throw new TRPCError(...)`.

5. **`chat.send` tenant isolation is correct.** The chat router uses `publicProcedure` with no tenant context. Verify every DB write in `chat.send` includes `tenantId: venue.tenantId` (sourced from the venue row, not from user input).

6. **`venue.delete` checks for dependent places.** Should refuse to delete a venue with existing places (prevents orphan records). Confirm this guard exists.

7. **`venue.update` does not include the tenant isolation middleware bypass.** The update path must include `tenantId` in the `where` clause.

8. **FORBIDDEN path tests exist.** For every `tenantProcedure` mutation, confirm there's a test that passes a wrong `tenantId` context and expects `FORBIDDEN` or `NOT_FOUND`.

9. **No router defined inside `apps/`.** Grep for `router(` in `apps/` — should return zero results.

**Expected outcome:** The slug uniqueness logic and `venue.delete` guard are the most likely areas to have subtle bugs.

---

## Phase 4 — Database Layer

**Files to review:**
- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/001_identity_foundation/migration.sql`
- `packages/db/prisma/migrations/002_platform_controls/migration.sql`
- `packages/db/prisma/migrations/003_venue_domain/migration.sql`
- `packages/db/src/helpers/audit.ts`
- `packages/db/src/helpers/audit.test.ts`
- `packages/db/src/helpers/membership-sync.ts`
- `packages/db/src/helpers/membership-sync.test.ts`
- `packages/db/src/helpers/feature-flags.ts`
- `packages/db/src/index.ts`
- `packages/db/src/client.ts`

**What to check:**

1. **Every tenanted model has `tenantId String` and a FK to `Tenant`.** Check `Venue`, `Place`, `VisitorSession`, `Message`, `TenantMembership`, `TenantFeatureFlag`, `DataAdapter`.

2. **`AuditLog` has no `updatedAt`.** Constitution rule — confirm.

3. **`User.id` and `Tenant.id` are `String` (Clerk IDs).** Not auto-increment. Not `uuid()`.

4. **`onDelete` behaviors are explicit.** No implicit cascade deletes. Check FKs on `Place → Venue`, `VisitorSession → Venue`, `Message → VisitorSession`.

5. **Required indexes exist.** Check for:
   - `Venue`: index on `(tenantId, slug)` unique
   - `Place`: index on `(venueId, tenantId)`
   - `VisitorSession`: unique on `anonymousToken`; index on `(venueId, tenantId)`
   - `Message`: index on `(sessionId, tenantId)`
   - `TenantMembership`: unique on `(tenantId, userId)`

6. **`writeAuditLog()` helper is used — not `db.auditLog.create()` directly.** Grep the codebase for `db.auditLog.create` — should return zero results.

7. **`client.ts` registers both middlewares.** Confirm both `tenantIsolationMiddleware` and any audit middleware are wired via `db.$use(...)`.

8. **`db` is the only export from `packages/db/src/index.ts` that other packages use.** No direct Prisma model types should be re-exported that bypass the middleware.

9. **Migrations are sequential and non-destructive.** 003 must not alter columns defined in 001 or 002 in a way that would require a manual data fill on an existing deployment.

**Expected outcome:** Most likely issue is a missing index or an `onDelete` not explicitly set.

---

## Phase 5 — App Layer: `apps/web`

**Files to review:**
- `apps/web/middleware.ts`
- `apps/web/app/layout.tsx`
- `apps/web/app/[venueSlug]/page.tsx`
- `apps/web/app/[venueSlug]/chat/page.tsx`
- `apps/web/app/[venueSlug]/chat/layout.tsx`
- `apps/web/app/api/trpc/[trpc]/route.ts`
- `apps/web/components/ChatWindow.tsx`
- `apps/web/components/LocationBanner.tsx`
- `apps/web/hooks/useSession.ts`
- `apps/web/hooks/useGeolocation.ts`
- `apps/web/lib/trpc.ts`

**What to check:**

1. **`apps/web` has no Clerk auth import.** The web app is fully anonymous. Grep for `@clerk/nextjs` in `apps/web/` — must return zero results.

2. **`anonymousToken` is not exposed in DOM attributes.** In `ChatWindow.tsx` (and anywhere else), confirm the UUID is stored in `localStorage` only — not in a `data-*` attribute, URL param, or rendered text. This was a known bug in packet 14 review.

3. **`useSession` generates UUID client-side and persists to `localStorage`.** Confirm it doesn't read from any URL param or request body.

4. **Geolocation is requested with user prompt** — not silently read. Check `useGeolocation.ts` calls `navigator.geolocation.getCurrentPosition` only after user interaction or explicit consent.

5. **`venueSlug` page redirects to `/[slug]/chat` or shows a landing.** It should not error if slug is not found — check `NOT_FOUND` handling renders gracefully.

6. **tRPC client in `lib/trpc.ts` points to the correct base URL.** It should use an env variable or relative path — not a hardcoded localhost URL.

7. **No `<a href>` for internal navigation.** Must use `next/link`.

8. **No permission checks in components.** The web app is anonymous — no role or auth logic should exist in any component.

9. **`apps/web` does not import from `apps/dashboard` or `apps/admin`.**

**Expected outcome:** The `anonymousToken` DOM exposure bug is the key one to verify was fixed. tRPC base URL hardcoding is a common oversight.

---

## Phase 6 — App Layer: `apps/dashboard`

**Files to review:**
- `apps/dashboard/middleware.ts`
- `apps/dashboard/app/(app)/layout.tsx`
- `apps/dashboard/app/(app)/page.tsx`
- `apps/dashboard/app/(app)/venues/page.tsx`
- `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`
- `apps/dashboard/app/(app)/venues/new/page.tsx`
- `apps/dashboard/app/(app)/venues/[venueId]/places/new/page.tsx`
- `apps/dashboard/app/(app)/venues/[venueId]/places/[placeId]/edit/page.tsx`
- `apps/dashboard/app/api/webhooks/clerk/route.ts`
- `apps/dashboard/components/VenueForm.tsx`
- `apps/dashboard/components/PlaceForm.tsx`
- `apps/dashboard/components/VenueCard.tsx`
- `apps/dashboard/components/PlaceRow.tsx`

**What to check:**

1. **Middleware enforces Clerk auth on all `(app)` routes.** In `middleware.ts`, confirm the matcher covers all dashboard routes and unauthenticated requests redirect to `/sign-in`.

2. **Dashboard root (`/`) redirects to `/venues`, not `/listings`.** This was a known bug from packet 15 review.

3. **`VenueForm` and `PlaceForm` store the tRPC client in `useRef`.** The client must not be re-created on every render. Confirm `useRef` is used, not `useMemo` or a bare call.

4. **Empty optional string fields are coerced to `undefined` before submission.** In both forms, fields that are optional (description, category) must not send empty strings to the API — they must be `undefined`. This was a known bug from packet 15 review.

5. **Clerk webhook route uses svix signature verification.** In `app/api/webhooks/clerk/route.ts`, confirm the raw body is verified with the svix SDK before processing. An unverified webhook must return `400`.

6. **No `db.*` calls in Server Components.** Data is fetched via tRPC procedures, not direct Prisma. Grep for `import.*@pathfinder/db` in `apps/dashboard/` — should return zero results.

7. **No permission checks in components for security.** Role-based UI hiding is acceptable for UX (e.g., hiding a delete button for STAFF) but must not be the only guard. Confirm the router procedure is the actual security control.

8. **Forms use `zodResolver` with schemas imported from `@pathfinder/api`, not duplicated.**

9. **`apps/dashboard` does not import from `apps/web` or `apps/admin`.**

**Expected outcome:** The dashboard redirect and tRPC client useRef are the key bugs to verify were fixed.

---

## Phase 7 — App Layer: `apps/admin`

**Files to review:**
- `apps/admin/middleware.ts`
- `apps/admin/app/layout.tsx`
- `apps/admin/app/(app)/layout.tsx`
- `apps/admin/app/(app)/page.tsx`
- `apps/admin/app/api/trpc/[trpc]/route.ts`
- `apps/admin/lib/trpc.ts`

**What to check:**

1. **Middleware enforces `PLATFORM_ADMIN` on every route except `/sign-in`.** In `middleware.ts`:
   - The matcher must cover all app routes.
   - The check must be `=== 'PLATFORM_ADMIN'`, not truthy.
   - Unauthenticated users redirect to `/sign-in`.
   - Non-admin authenticated users get `403` or redirect — they must not see any admin UI.

2. **`adminProcedure` is a second independent check.** The tRPC `adminProcedure` in `packages/api` must also call `requirePlatformAdmin`. This is the defense-in-depth layer — middleware alone is not sufficient.

3. **Admin app does not import from `apps/web` or `apps/dashboard`.**

4. **No `bypassTenantIsolation` usage outside admin routers.** Already covered in Phase 1 grep, but double-check here.

5. **If any admin mutations exist**, confirm they call `writeAuditLog()` before returning.

**Expected outcome:** Admin app is mostly scaffold at this stage. Main risk is the middleware `PLATFORM_ADMIN` check being truthy instead of strict equality.

---

## Phase 8 — Test Coverage Audit

**Scope:** Run tests and evaluate coverage gaps — do not fix failures found in earlier phases (assume they're already fixed).

**Steps:**

1. Run `pnpm turbo run test` from repo root. Confirm all tests pass.

2. Run `pnpm turbo run test --filter=@pathfinder/db -- --coverage` and confirm `tenant-isolation.ts` shows 100% branch coverage.

3. For each router (`venue`, `place`, `chat`), verify the test file contains:
   - At least one success path per mutation
   - At least one FORBIDDEN path for each `tenantProcedure` mutation (wrong tenant context)
   - At least one NOT_FOUND path for getById/update/delete with a valid tenant but nonexistent ID

4. For `packages/auth`, verify:
   - `resolveSession` returning `null` for unauthenticated request is tested
   - `requireTenantRole` is tested with each role pairing (STAFF < MANAGER < OWNER)

5. **Write any missing FORBIDDEN or NOT_FOUND tests.** This is the one phase where new test files may be created.

6. After writing new tests, run `pnpm turbo run test` again to confirm everything passes.

**Expected outcome:** Chat router tests are the most likely to be thin — it's complex to test without mocking Anthropic. Confirm mock injection via `_setAnthropicClientForTesting` is used in chat tests.

---

## Phase 9 — Monorepo Boundary and Config Audit

**Steps (grep-based, no code to write unless violations found):**

1. **No `@prisma/client` imports outside `packages/db`.**
   ```
   grep -r "from '@prisma/client'" apps/ packages/api packages/auth packages/config packages/analytics packages/integrations packages/jobs packages/ui
   ```
   Must return zero results.

2. **No `@clerk/nextjs` imports outside `packages/auth`.**
   ```
   grep -r "from '@clerk/nextjs'" apps/ packages/api packages/db packages/config
   ```
   Must return zero results (only `packages/auth` is allowed).

3. **No `bullmq` imports outside `apps/workers`.**
   ```
   grep -r "from 'bullmq'" packages/ apps/web apps/dashboard apps/admin
   ```
   Must return zero results.

4. **No cross-app imports.** Apps must not import from each other.
   ```
   grep -r "from '.*apps/web'" apps/dashboard apps/admin
   grep -r "from '.*apps/dashboard'" apps/web apps/admin
   grep -r "from '.*apps/admin'" apps/web apps/dashboard
   ```

5. **No `console.log` with PII.** Grep for `console.log` across the codebase and confirm no log statement includes email, name, or phone fields. Structured logger from `packages/config` should be used instead.
   ```
   grep -r "console.log" packages/ apps/
   ```

6. **No router defined in `apps/`.** 
   ```
   grep -r "router(" apps/
   ```
   Should return zero results.

7. **`pnpm-lock.yaml` is committed.** Confirm it exists and is not in `.gitignore`.

8. **Feature flag keys come from `packages/config/src/feature-flags.ts`.** Grep for hardcoded flag key strings in routers and components.

**Expected outcome:** If CI has been running, most of these will pass. The `console.log` audit is the most likely to surface issues.

---

## Phase 10 — Final Integration Pass

**This phase is done by a human (Tom), not Codex.**

1. Start the dashboard app locally: `pnpm --filter=@pathfinder/dashboard dev`
2. Sign in with a test Clerk user who has an org.
3. Create a venue — confirm it appears in the list.
4. Add a place to the venue.
5. Edit the place — confirm changes persist.
6. Delete the place, then delete the venue.
7. Open `apps/web` locally: `pnpm --filter=@pathfinder/web dev`
8. Navigate to `/[your-venue-slug]` — confirm redirect to chat.
9. Send a message — confirm Claude responds.
10. Refresh the page — confirm chat history is preserved (session token in localStorage).

**Anything that fails here is a bug to file as a separate issue, not a constitution violation.**

---

## Summary Table

| Phase | Focus | Risk Level | Can Codex Auto-Fix? |
|-------|-------|-----------|---------------------|
| 1 | Tenant isolation middleware | Critical | Yes |
| 2 | Auth session + permissions | Critical | Yes |
| 3 | tRPC routers + role gates | High | Yes |
| 4 | DB schema + migrations + helpers | High | Partial (no migration edits in prod) |
| 5 | apps/web | Medium | Yes |
| 6 | apps/dashboard | Medium | Yes |
| 7 | apps/admin | Medium | Yes |
| 8 | Test coverage | Medium | Yes (write new tests) |
| 9 | Monorepo boundaries + config | Low | Yes (fix imports) |
| 10 | Manual integration test | — | No — human only |
