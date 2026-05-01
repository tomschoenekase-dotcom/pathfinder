# PathFinderOS — Full Codebase Review

> This file is a comprehensive audit task for AI-assisted review.
> Read `CLAUDE.md` fully before starting. Every fix must conform to the rules in that file.
> Work through each section in order. For each item: read the file, identify the issue, fix it, verify it compiles.
> Do not skip sections. Do not refactor code that is not broken. Fix only what is actually wrong.

---

## Project Map

```
apps/
  web/          — Public marketing site + per-venue guest chat (Next.js)
  dashboard/    — Operator dashboard (Next.js, Clerk auth)
  admin/        — Platform admin console (Next.js, Clerk + PLATFORM_ADMIN claim)
packages/
  api/          — All tRPC routers (the only place business logic lives)
  db/           — Prisma client, middleware, helpers
  auth/         — Clerk session resolution, role checks
  analytics/    — Event emission helpers
  config/       — Env vars, logger, feature flags
  jobs/         — BullMQ queue abstractions
  ui/           — Shared shadcn components
```

---

## Section 1 — API Layer: `packages/api/src/routers/`

Read every router file listed below. For each procedure check:

- Correct base procedure used (`publicProcedure` / `tenantProcedure` / `adminProcedure`)
- Input validated with Zod in `.input()`
- `TRPCError` thrown (never raw `Error`)
- `tenant_id` included in every query against a tenanted table
- `IntegrationConnection.credentials` never returned in any response
- `requireRole` called at the correct role level for mutations
- `writeAuditLog()` called for every admin mutation
- Analytics `emitEvent()` called after mutation succeeds, not before
- No synchronous external API calls (embedPlace inline is an accepted documented exception)

### 1a. `packages/api/src/routers/venue.ts`

Read the full file. Verify:

- `venue.list` — uses `tenantProcedure`, filters by `activeTenantId`, returns `_count.places`
- `venue.getById` — throws `NOT_FOUND` if venue doesn't belong to the caller's tenant
- `venue.create` — requires `MANAGER` role minimum, generates a unique slug via `uniqueSlug()`, calls `emitEvent('venue.created', ...)` after creation
- `venue.update` — requires `MANAGER` role, re-generates slug if name changes, calls `emitEvent('venue.updated', ...)`
- `venue.delete` — requires `OWNER` role, calls `emitEvent('venue.deleted', ...)`
- `venue.getAiConfig` — returns `aiTone`, `aiFeaturedPlaceId`, `aiGuideNotes`, never returns raw credentials
- `venue.updateAiConfig` — requires `MANAGER` role minimum
- No procedure returns `geoBoundary` in list views (large field, intentionally excluded)

**Fix any procedure that:**

- Throws `new Error(...)` instead of `new TRPCError(...)`
- Omits `tenant_id` from a where clause on a tenanted table
- Uses `protectedProcedure` where `tenantProcedure` is correct
- Does not validate all inputs with Zod

### 1b. `packages/api/src/routers/place.ts`

Read the full file. Verify:

- `place.list` — `tenantProcedure`, filters by both `tenantId` AND `venueId`, verifies venue belongs to tenant via `assertVenueBelongsToTenant()`
- `place.getById` — verifies `tenantId` ownership, throws `NOT_FOUND` for cross-tenant access
- `place.create` — requires `MANAGER` role, calls `embedPlace()` after successful save (failure swallowed — do not throw on embed failure)
- `place.update` — requires `MANAGER` role, calls `embedPlace()` after successful save, returns `NOT_FOUND` for wrong tenant
- `place.delete` — requires `MANAGER` role
- `place.bulkCreate` — respects `BULK_CREATE_LIMIT = 500`, calls `embedPlace` for all created places concurrently, failures swallowed
- `photoUrl` field: never returned as part of an unauthenticated response that could leak it (it's a plain URL, not credentials — but verify it's included in `placeSelect`)

**Check `packages/api/src/schemas/place.ts`:**

- `CreatePlaceInput.photoUrl`: must accept empty string `''` and `undefined`, convert both to `undefined` before hitting the DB
- `UpdatePlaceInput.photoUrl`: must accept empty string `''`, `null`, and `undefined`, convert `''` to `null`
- Verify the current schema uses `z.union([z.string().url(), z.literal('')])` pattern (not `z.preprocess`) for both input types
- If still using `z.preprocess`, replace with the union pattern — `z.preprocess` does not reliably run in react-hook-form's zodResolver before field validation

### 1c. `packages/api/src/routers/chat.ts`

Read the full file. Verify:

- `chat.session` — `publicProcedure`, resolves `tenantId` from the venue row (not from request input), upserts `VisitorSession`
- `chat.send` — rate limit check runs BEFORE the Anthropic API call, not after
- Rate limit: checks both `ratelimit:chat:session:{anonymousToken}` (60/hr) and `ratelimit:chat:venue:{venueId}` (30/min), throws `TOO_MANY_REQUESTS` if either fails
- Embedding failure falls back to geo-nearest (does not throw to the caller)
- `searchPlacesByEmbedding` called with both `venueId` AND `tenantId` — verify both params are passed
- System prompt built via `buildVenueSystemPrompt()` — never constructed inline in the router
- Claude response failure returns a graceful fallback string, never throws to the caller
- Both user and assistant messages persisted in a single `$transaction` after the Claude call
- `emitEvent` calls are wrapped in try/catch — analytics failure must never surface as a 500
- `chat.history` — `publicProcedure`, verifies `session.venueId === input.venueId` before returning messages
- `HISTORY_LIMIT = 10` messages passed to Claude, `HISTORY_LOAD_LIMIT = 40` messages returned to the UI — confirm these constants are not swapped

**Check `packages/api/src/lib/rate-limit.ts`:**

- Redis client created with `maxRetriesPerRequest: 1` and `enableOfflineQueue: false` (fails fast, does not queue requests)
- `getRedisClient()` returns `null` when `REDIS_URL` is unset — verify `checkRateLimit` returns `true` (allow) in this case
- Redis errors caught and logged — verify `checkRateLimit` returns `true` on any caught error
- `_resetRateLimitForTesting()` exported for test isolation

### 1d. `packages/api/src/routers/analytics.ts`

Read the full file. Verify:

- `analytics.trackEvent` — `publicProcedure`, resolves `tenantId` from venue row (not from request), writes to `AnalyticsEvent` table
- `analytics.getDailyStats` — `tenantProcedure`, filters by `activeTenantId`, reads from `DailyRollup` (not OLTP tables)
- `analytics.getTopQuestions` — `tenantProcedure`, reads from `AnalyticsEvent` where `eventType = 'message.sent'`, extracts `metadata.message`, groups and sorts by frequency, returns top 10
- `analytics.getTopQuestions` filters by `tenantId` (not just event type) — verify the `where` clause includes `tenantId: ctx.session.activeTenantId`
- `analytics.getLatestDigest` and `analytics.listDigests` — both use `tenantProcedure`, filter by `activeTenantId`
- `AnalyticsEvent` table is never updated or deleted in any procedure — append only

### 1e. `packages/api/src/routers/operational-update.ts`

Read the full file. Verify:

- `operationalUpdate.list` — `tenantProcedure`, filters by `tenantId`
- `operationalUpdate.create` — requires `MANAGER` role, calls `writeAuditLog()` after creation
- `operationalUpdate.deactivate` — requires `MANAGER` role, verifies update belongs to tenant, calls `writeAuditLog()`
- `expiresAt` field — must be a future date; check if there's a Zod refinement enforcing this, add one if missing: `.refine(d => d > new Date(), { message: 'Expiry must be in the future' })`
- `redirectTo` field — if present, must be a valid URL or a relative path starting with `/`; verify Zod validates this

### 1f. `packages/api/src/routers/admin/_admin.ts`

Read the full file. Verify:

- Every procedure uses `adminProcedure` (never `tenantProcedure` or `publicProcedure`)
- `admin.listClients` — uses `withTenantIsolationBypass()`, returns tenant list with active memberships
- `admin.createClient` — calls `writeAuditLog()` after creating tenant + membership
- `admin.triggerWeeklyDigest` (or similar) — calls `writeAuditLog()`, enqueues job via `packages/jobs`, does not do work inline
- No procedure returns raw credentials or encrypted fields
- `bypassTenantIsolation` used only inside this file, via `withTenantIsolationBypass()` helper

---

## Section 2 — Database Layer: `packages/db/`

### 2a. Tenant Isolation Middleware

Read `packages/db/src/middleware/tenant-isolation.ts`. Verify:

- Every table in the schema that has a `tenant_id` column is listed in the middleware's tenanted-tables array
- Tables to check against the schema: `tenants` (not tenanted), `users` (not tenanted), `tenant_memberships`, `audit_logs`, `tenant_feature_flags`, `venues`, `places`, `visitor_sessions`, `messages`, `data_adapters`, `operational_updates`, `analytics_events`, `guest_sessions`, `daily_rollups`, `job_records`, `weekly_digests`
- Middleware throws (does not just log) when `tenant_id` is missing from a query against a tenanted table
- `bypassTenantIsolation` flag is checked — verify the flag name matches what `withTenantIsolationBypass()` sets

### 2b. Audit Helper

Read `packages/db/src/helpers/audit.ts`. Verify:

- `writeAuditLog()` accepts `{ tenantId, actorId, actorRole, action, targetType, targetId, beforeState?, afterState? }`
- Writes via `db.auditLog.create()` directly (this helper is the one allowed place to write audit logs directly)
- Does not use `db.auditLog.update()` or `db.auditLog.delete()` anywhere
- `tenantId` is nullable (platform-level actions pass `null`)

### 2c. Semantic Search Helper

Read `packages/db/src/helpers/semantic-search.ts`. Verify:

- `searchPlacesByEmbedding` — raw SQL includes explicit `tenant_id = ${tenantId}` bind parameter
- `storePlaceEmbedding` — updates by `placeId` only (the placeId must be obtained from a prior tenant-isolated query — this is documented)
- `haversineDistanceMeters` is calculated in JS after the query, not in SQL — acceptable, document why if not already commented
- Return type `SemanticPlace` does not include `embedding` column (vector data must not be returned to callers)

---

## Section 3 — Dashboard App: `apps/dashboard/`

For each page: read the file, check that it renders correctly for the expected data states (empty, populated, error), check that all tRPC calls use the correct procedure, check that forms submit correctly.

### 3a. Root Layout and Auth Shell

Read `apps/dashboard/app/layout.tsx` and `apps/dashboard/app/(app)/layout.tsx`. Verify:

- Root layout wraps with Clerk `<ClerkProvider>`
- App layout (`(app)/layout.tsx`) includes `DashboardShell` with navigation
- Navigation links point to valid routes: `/` (overview), `/venues`, `/analytics`, `/ai-controls`, `/operational-updates`
- No broken links to routes that don't exist (e.g. `/settings` was previously a known broken link — confirm it's removed)
- `DashboardShell` highlights the correct nav item for the current route

Read `apps/dashboard/components/DashboardShell.tsx`. Verify:

- Active nav state uses `usePathname()` comparison correctly
- All nav items link to existing pages
- Shell does not import from any `apps/*` package other than its own

### 3b. Onboarding Pages

Read `apps/dashboard/app/onboarding/page.tsx`. Verify:

- Auto-selects org and redirects to `/` when user belongs to exactly one organization
- Shows org picker / create org UI when user belongs to multiple orgs
- Does not crash if `userMemberships.data` is undefined or empty

Read `apps/dashboard/app/(app)/onboarding/setup/page.tsx`. Verify:

- Step indicator renders and updates correctly as the user progresses
- Step 1 (venue info): name, category, lat, lng, description fields present with helper text
- Step 2 (first place): name, type, lat, lng fields present with helper text including Google Maps coordinate instructions
- Form error displayed at the TOP of the form (above step indicator or directly below it), not only at the bottom
- On success: confirmation screen shown before redirect, not an immediate navigation jump
- Confirmation screen uses `setTimeout` + `router.push('/venues/{venueId}?onboarded=1')` — verify `venueId` is correctly threaded from the create response
- `CreateVenueInput` and `CreatePlaceInput` Zod schemas used as form resolvers (no schema duplication)
- `photoUrl` field on the place step: `type="text"`, not `type="url"` — browser native URL validation must not block submission

### 3c. Dashboard Overview

Read `apps/dashboard/app/(app)/page.tsx` and `apps/dashboard/components/DashboardOverview.tsx`. Verify:

- Redirects to `/onboarding/setup` when `venues.length === 0`
- Stat cards (Venues, Places, Alerts, Sessions) all show correct data from their respective queries
- All stat cards are clickable links to their respective pages
- Quick action buttons are context-aware: show "Add first venue" when no venues, show "Add place" when venues exist but have few places
- `sessionsThisWeek` computed from `DailyRollup` data, not from OLTP tables
- `activeAlerts` computed from `operationalUpdates` array filtered by `isActive`
- No crash when `dailyStats` is an empty array

### 3d. Venues List

Read `apps/dashboard/app/(app)/venues/page.tsx` and `apps/dashboard/components/VenueCard.tsx`. Verify:

- Page calls `venue.list` which returns `_count.places` — verify place count is displayed on each card
- `VenueCard` is fully clickable (the whole card navigates to the venue detail page, not just a button)
- Empty state shown when `venues.length === 0` with a link to create a venue
- No N+1 query (place count included in the list query, not fetched per-venue)

### 3e. Venue Detail

Read `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`. Verify:

- Loads venue, AI config, and places in a single `Promise.all` — not sequential awaits
- Shows `?onboarded=1` success banner when `justOnboarded === true`
- Guest Chat URL box has been removed (it was removed in a previous session — confirm the article element with "Guest chat URL" is absent)
- "Test AI chat" button style matches "Edit venue" and "AI Controls" buttons: `border-slate-300 bg-white text-slate-700`
- `CopyUrlButton` import has been removed if the Guest Chat URL box was removed
- Places table shows name, area, type badge, active/inactive status badge, coordinates, and an Edit link
- `notFound()` called when venue belongs to a different tenant (tRPC `NOT_FOUND` error caught correctly)
- `formatCoordinate` handles `null` gracefully (shows "Not set")

### 3f. Venue Create / Edit

Read `apps/dashboard/app/(app)/venues/new/page.tsx` and `apps/dashboard/app/(app)/venues/[venueId]/edit/page.tsx`. Verify:

- Both pages use `VenueForm` component
- `VenueForm` uses `CreateVenueInput` / `UpdateVenueInput` as Zod resolvers
- Form submits correctly and redirects to `/venues/{venueId}` on success
- Edit page pre-populates all fields from the existing venue data

Read `apps/dashboard/components/VenueForm.tsx`. Verify:

- All fields present: name, slug (if editable), category, description, lat, lng, guide notes
- Category dropdown shows all valid options matching the schema enum: `ZOO`, `AQUARIUM`, `MUSEUM`, `MALL`, `SPORTS_VENUE`, `PARK`, `OTHER`
- Lat/lng fields use `Controller` + `parseNumber` (not raw string input) to ensure numeric values
- `isActive` checkbox present on edit mode
- Error messages shown per field, not just a generic banner

### 3g. Place Create / Edit

Read `apps/dashboard/app/(app)/venues/[venueId]/places/new/page.tsx` and `apps/dashboard/app/(app)/venues/[venueId]/places/[placeId]/edit/page.tsx`. Verify:

- Both pages use `PlaceForm` component with correct `mode` prop

Read `apps/dashboard/components/PlaceForm.tsx`. Verify:

- `photoUrl` field: `type="text"` (not `type="url"`) — browser native URL validation must not block submission
- `photoUrl` empty value: submits correctly as `undefined` for create, `null` for update
- Lat/lng fields use `Controller` + `parseNumber` pattern
- Tags field uses `Controller` with `splitTags()` — comma-separated input converted to array
- "Advanced options" section collapses by default for new places, expands if any advanced field has a value (edit mode)
- Delete button present in edit mode, triggers confirmation dialog, redirects to venue detail on success
- `importanceScore` defaults to `0` and accepts numeric input only

### 3h. AI Controls

Read `apps/dashboard/app/(app)/ai-controls/page.tsx` and `apps/dashboard/components/AiControlsForm.tsx`. Verify:

- `?venue=` query param pre-selects the correct venue in the venue picker
- Venue picker shows all of the tenant's venues
- AI tone selector shows: `FRIENDLY`, `PROFESSIONAL`, `PLAYFUL`
- Featured place picker: loads places for the selected venue, allows clearing the selection
- Guide notes field: textarea, no character limit enforced in UI that's stricter than the schema
- Form saves correctly via `venue.updateAiConfig` — verify this procedure exists in the router
- Success feedback shown after save

### 3i. Operational Updates

Read `apps/dashboard/app/(app)/operational-updates/page.tsx` and `apps/dashboard/app/(app)/operational-updates/new/page.tsx`. Verify:

- List page shows all updates with severity badge (INFO / WARNING / CLOSURE / REDIRECT), title, venue name, expiry date, and active/inactive status
- Deactivate action available on active updates
- New update form: venue picker, severity selector, title, body, optional place selector, expiry date/time
- Expiry date input: must be future date — check if UI enforces this or if it only validates server-side
- Severity `REDIRECT` shows `redirectTo` field; other severities hide it

Read `apps/dashboard/components/OperationalUpdateForm.tsx` and `apps/dashboard/components/OperationalUpdatesList.tsx`. Verify:

- `OperationalUpdatesList` displays the deactivate button and calls the correct tRPC mutation
- After deactivation, the list refreshes (router.refresh() or re-query)

### 3j. Analytics Page

Read `apps/dashboard/app/(app)/analytics/page.tsx`. Verify:

- Page loads: digest list, selected digest details, daily stats, and top questions — all in parallel if possible
- **Guest Questions section** (added in Phase 3): renders correctly with question text and count badge
- Empty state for Guest Questions: "No guest messages recorded yet." or equivalent
- Count badge shown for questions with `count > 1`, consistent display for `count === 1`
- Daily stats chart / graph renders without crash when `dailyStats` is empty
- Digest list: shows week range, status, session count, message count
- Digest detail: shows insights grouped by type (trend, confusion, interest, recommendation) with correct color coding
- `?digest=` query param pre-selects a specific digest

---

## Section 4 — Web App: `apps/web/`

### 4a. Root Layout

Read `apps/web/app/layout.tsx`. Verify:

- `<link rel="manifest" href="/manifest.webmanifest" />` — filename must be `manifest.webmanifest`, not `manifest.json`
- Service worker registration script is present in `<body>` (registers `/sw.js`)
- `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags present for iOS PWA support
- Default metadata title is `"PathFinder"` (individual pages override this)

### 4b. PWA Assets

Check `apps/web/public/manifest.webmanifest`. Verify:

- File exists at this exact path (not `manifest.json`)
- Contains both icon sizes: `icon-192.png` (192×192) and `icon-512.png` (512×512)
- Both icons have `"purpose": "any maskable"`
- `"display": "standalone"` present
- `"scope": "/"` present
- `"theme_color"` matches the app's dark slate tone (`#0f172a`)

Check `apps/web/public/sw.js`. Verify:

- Service worker installs correctly — caches `/` and `/offline.html` on install
- `skipWaiting()` called on install
- `clients.claim()` called on activate
- Fetch handler: navigation requests fall back to `/offline.html` on network failure
- Non-navigation requests pass through without caching (correct for an API-heavy app)

Check that `apps/web/public/manifest.json` either no longer exists or is harmless (if it still exists alongside `manifest.webmanifest`, it won't cause issues but the old file should be deleted to avoid confusion).

### 4c. Marketing Homepage

Read `apps/web/app/page.tsx`. Verify:

- File is NOT the old placeholder ("Venue chat starts from a venue link") — it must be the marketing page
- Hero section: headline, subheadline, "Request a demo" CTA (`mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request`), "See it in action" link to `#demo`
- How it works: 3 steps (Add your places, AI learns your venue, Guests get instant answers)
- Example chat bubbles section (`id="demo"` anchor)
- Venue types section with `lucide-react` icons — confirm no other icon library imported
- CTA footer with "Get in touch" mailto link
- Page is a server component (no `'use client'`)
- No `console.log`, no TypeScript errors
- Responsive: works on mobile (375px) and desktop (1280px)

### 4d. Venue Landing Page

Read `apps/web/app/[venueSlug]/page.tsx`. Verify:

- Fetches venue by slug (public query, no auth)
- Shows 404 / not-found for inactive or non-existent venues
- Links to `/{venueSlug}/chat` for the chat experience
- Renders venue name, description, and category
- "Start chatting" or equivalent CTA button navigates to the chat page

### 4e. Chat Layout (Metadata)

Read `apps/web/app/[venueSlug]/chat/layout.tsx`. Verify:

- Exports `generateMetadata` as an async server function (NOT from the `page.tsx` which is `'use client'`)
- Fetches venue name by slug using `db.$queryRaw` (cross-tenant public lookup)
- Returns `title: "{venue.name} — PathFinder"` when venue found
- Returns `title: "PathFinder"` fallback when venue not found (no throw)
- Existing `viewport` export preserved and unchanged
- `db` imported from `@pathfinder/db` — not `PrismaClient` directly

### 4f. Chat Page

Read `apps/web/app/[venueSlug]/chat/page.tsx`. Verify:

- Marked `'use client'` at the top
- Fetches venue data on mount via tRPC `venue.getBySlug` (or equivalent public procedure)
- `useGeolocation` hook: requests location, updates session when position changes by >10m
- `useSession` hook: creates/upserts visitor session, returns `anonymousToken` and `sessionId`
- Chat history loaded on mount via `chat.history` query — returning visitor sees their prior messages
- Sending a message: calls `chat.send` with `venueId`, `anonymousToken`, `message`, `lat`, `lng`
- Loading state shown while waiting for response (spinner, typing indicator, or similar)
- `TOO_MANY_REQUESTS` error from rate limiting: shown as a user-friendly message ("You've reached the message limit. Please try again later."), not a raw error
- Place cards shown below assistant messages when `places` array is non-empty in the response
- Quick prompt chips shown when conversation is empty, hidden after first message
- Back navigation link present (to venue landing page)
- `LocationBanner`: shown while location is being requested, hidden once granted or denied, no crash if geolocation is unavailable

Read `apps/web/components/ChatWindow.tsx`. Verify:

- Renders `MessageBubble` for each message in the history
- Scrolls to bottom on new message
- Input field: clears after send, disabled while request is in flight
- Send button: disabled while submitting, shows spinner

Read `apps/web/components/PlaceCard.tsx`. Verify:

- Shows place name, type, distance (natural language from the response, not raw meters)
- Photo displayed if `photoUrl` is present; placeholder shown if not
- Image is lazy-loaded

Read `apps/web/components/QuickPromptChips.tsx`. Verify:

- Renders a set of suggested prompts as clickable chips
- Chips use `flex-wrap` so they wrap on small screens (not overflow)
- Clicking a chip calls the `onSelect` callback with the prompt text

Read `apps/web/components/LocationBanner.tsx`. Verify:

- Shows during `'loading'` state, hidden for `'granted'`, `'denied'`, `'unavailable'`
- No retry button shown while location request is in progress
- Does not crash when `navigator.geolocation` is undefined (some browsers/contexts)

### 4g. Not Found Page

Read `apps/web/app/not-found.tsx`. Verify:

- Renders a user-friendly 404 message
- Includes a link back to `/` (the marketing homepage)

---

## Section 5 — Admin Console: `apps/admin/`

### 5a. Middleware

Read `apps/admin/middleware.ts`. Verify:

- `PLATFORM_ADMIN` check enforced on every route except `/sign-in`
- Check uses `=== 'PLATFORM_ADMIN'` string comparison, not truthy check
- Unauthenticated users redirected to `/sign-in`
- Authenticated non-admin users receive `401` or redirect to `/sign-in`

### 5b. Admin Layout and Overview

Read `apps/admin/app/layout.tsx` and `apps/admin/app/(app)/layout.tsx`. Verify:

- Root layout wraps with Clerk `<ClerkProvider>`
- App layout includes admin navigation
- Navigation links: dashboard overview, clients list

Read `apps/admin/app/(app)/page.tsx`. Verify:

- Calls `admin.ping` to verify admin access — if it throws, the page should handle it gracefully
- Shows platform stats or links to main admin sections

### 5c. Clients List

Read `apps/admin/app/(app)/clients/page.tsx`. Verify:

- Calls `admin.listClients`
- Shows tenant name, status, plan tier, member count, created date
- Each row links to `/clients/{tenantId}`
- Empty state when no clients exist

### 5d. Client Detail

Read `apps/admin/app/(app)/clients/[tenantId]/page.tsx`. Verify:

- Calls `admin.getClient` (or loads from the list) by `tenantId`
- Shows tenant details, member list, venue count
- Status change action (ACTIVE / SUSPENDED / TRIAL) with confirmation
- Any status change calls `writeAuditLog()` in the underlying procedure
- Shows venues count and links if venues exist

---

## Section 6 — Security Audit

Work through each item below. This is a checklist of the most critical security rules from `CLAUDE.md`. For each item, search the codebase for violations.

### 6a. Tenant Isolation

Run a search for any of these patterns in `apps/*` and `packages/api/`:

- `PrismaClient` instantiated directly (should only appear in `packages/db/src/client.ts`)
- `activeTenantId` read from `input.*`, `params.*`, `searchParams.*`, or `req.body.*` — must only come from `ctx.session.activeTenantId`
- `db.*.findMany({ where: {} })` with no `tenantId` filter on a tenanted model
- `bypassTenantIsolation` used outside of `packages/api/src/routers/admin/`

Fix any violations found.

### 6b. Auth Checks

Search for:

- `publicProcedure` used for any procedure that reads or writes tenant-private data
- Permission checks in React components (checking role to conditionally render UI is fine; checking role as a _security_ gate in a component is not)
- `isPlatformAdmin` checked with a truthy check instead of `=== 'PLATFORM_ADMIN'`

### 6c. Sensitive Fields

Search for:

- `credentials` field returned in any tRPC response select shape
- `encrypted_` prefix fields returned in any tRPC response
- `password` or `secret` fields returned in any response

### 6d. Error Handling

Search `packages/api/src/routers/` for:

- `throw new Error(` — must be `throw new TRPCError(`
- `return { success: false, error: '...' }` — must use tRPC error system
- Bare `catch {}` blocks that silently swallow errors without logging (analytics emitEvent is the one accepted exception — it logs internally)

### 6e. Analytics Events

Search `apps/*/` and `packages/api/` for:

- `emitEvent(` called from a React component or client file — must only be called server-side
- `emitEvent(` called BEFORE the mutation it's tracking succeeds

---

## Section 7 — Data Integrity Checks

### 7a. Place Embeddings

Verify the embedding flow end-to-end:

- `embedPlace()` is called after `place.create`, `place.update`, and `place.bulkCreate`
- `embedPlace()` failure is caught inside the function and logged — never re-thrown to the caller
- `storePlaceEmbedding()` in `packages/db/src/helpers/semantic-search.ts` uses `$executeRaw` to set the `vector(1536)` column — confirm Prisma's typed API cannot handle this type and the raw SQL approach is necessary (it is — document with comment if not already present)
- The `EMBEDDING_MODEL = 'text-embedding-3-small'` and `EMBEDDING_DIMENSIONS = 1536` constants in `packages/api/src/lib/embeddings.ts` match what's stored in the DB column (`vector(1536)`)

### 7b. Venue Slug Uniqueness

Read `uniqueSlug()` in `venue.ts`. Verify:

- Uniqueness scoped to `tenantId + slug` (not global) — matches the DB constraint `@@unique([tenantId, slug])`
- Infinite loop protection: the `suffix` counter increments correctly, there's no way to loop forever in practice (bounded by the number of venues a tenant could have)

### 7c. Operational Update Expiry

Verify:

- `expiresAt` stored in UTC
- List queries filter by `expiresAt > now()` OR `isActive = true` — check which approach is used and whether expired-but-still-active updates are handled correctly
- If `isActive` is the only gate (not `expiresAt`), verify there's a background job or scheduled process that deactivates expired updates

---

## Section 8 — Package Boundaries

Run searches to verify no cross-package import violations:

1. Search `apps/web/**` for imports from `apps/dashboard` or `apps/admin` — must be zero
2. Search `apps/dashboard/**` for imports from `apps/web` or `apps/admin` — must be zero
3. Search `apps/admin/**` for imports from `apps/web` or `apps/dashboard` — must be zero
4. Search `packages/db/**` for imports from `packages/api` — must be zero
5. Search `packages/ui/**` for tRPC calls or `db.*` calls — must be zero (UI components receive data as props)
6. Search `packages/integrations/**` for imports from `packages/api` — must be zero
7. Search `apps/web/**`, `apps/dashboard/**`, `apps/admin/**` for `import.*bullmq` — must be zero (only `apps/workers` may import BullMQ directly)

Fix any violations found. These are hard architectural constraints.

---

## Section 9 — Known Issues to Resolve

### 9a. Dashboard TypeScript Build Error

The pre-existing issue in `apps/dashboard/lib/trpc.ts` around "inferred type portability" causes `turbo run typecheck` to fail for the dashboard app. This is a known issue that was not introduced by recent changes.

Read `apps/dashboard/lib/trpc.ts`. The likely cause is that the tRPC client's inferred type is too complex to be exported across module boundaries without an explicit type annotation.

Fix approach:

- Add an explicit return type annotation to the function or variable that's causing the portability error
- Alternatively, extract the type from `AppRouter` using `inferRouterOutputs` / `inferRouterInputs` from `@trpc/server` and use those explicit types instead of relying on inference

Run `pnpm --filter @pathfinder/dashboard typecheck` after the fix to confirm zero errors.

### 9b. Admin Router Test Failures

The pre-existing failures in `packages/api/src/routers/admin/_admin.test.ts` are caused by `writeAuditLog` not being exported from the `@pathfinder/db` mock.

Read `packages/api/src/routers/admin/_admin.test.ts`. Fix the mock setup:

```ts
vi.mock('@pathfinder/db', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    writeAuditLog: vi.fn().mockResolvedValue(undefined),
    // other mocked methods
  }
})
```

Run `pnpm --filter @pathfinder/api exec vitest run src/routers/admin/_admin.test.ts` to confirm the tests pass after the fix.

### 9c. Place Router Test Failures

Read `packages/api/src/routers/place.test.ts`. Check if tests are failing due to the `photoUrl` schema change (from `z.preprocess` to `z.union`). Update any test fixtures that pass `photoUrl: ''` to verify the new behavior:

- Empty string `''` → treated as no URL (undefined for create, null for update)
- Valid URL → stored as-is
- Invalid URL string → validation error

---

## Section 10 — Final Verification

After completing all sections above, run the following and confirm all pass:

```bash
pnpm --filter @pathfinder/api exec vitest run
pnpm --filter @pathfinder/web typecheck
pnpm --filter @pathfinder/web lint
pnpm --filter @pathfinder/dashboard typecheck
pnpm --filter @pathfinder/dashboard lint
pnpm --filter @pathfinder/admin typecheck
turbo run typecheck --filter=packages/*
```

Expected outcome:

- Zero TypeScript errors across all packages and apps
- Zero lint errors across all packages and apps
- All API tests pass (including the previously failing admin and place tests)
- Web app builds without error

If any check still fails after your fixes, document the remaining issue with the exact error message and file location — do not suppress errors with `// @ts-ignore` or `eslint-disable` comments.
