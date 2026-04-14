# PathFinderOS — Codex Sprint 002

## Phased Implementation Plan

> Feed each task block individually to Codex. Complete tasks in order within each phase.
> Tasks within the same phase are independent unless noted.
> All code must comply with CLAUDE.md. Read it before starting any task.

---

## Phase 1 — Infrastructure & Correctness (do first, unblocks everything)

### Task 1.1 — Fix broken DB migration history

**Context:**
The migration `packages/db/prisma/migrations/20260413120000_add_weekly_digest/migration.sql` fails when applied because the `WeeklyDigestStatus` enum type already exists in the database. This blocks all future migrations from running in production.

**What to do:**

1. Open `packages/db/prisma/migrations/20260413120000_add_weekly_digest/migration.sql`.
2. Wrap the `CREATE TYPE "WeeklyDigestStatus"` statement with an idempotency guard:
   ```sql
   DO $$ BEGIN
     CREATE TYPE "WeeklyDigestStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$;
   ```
3. Do the same for any other `CREATE TYPE` statements in that file that may already exist.
4. Do not create a new migration file — fix the existing one in place (it has not been cleanly applied anywhere yet).
5. Run `pnpm --filter @pathfinder/db db:migrate` and confirm it succeeds without errors.
6. Run `turbo run typecheck` — zero errors.

---

### Task 1.2 — Admin console: empty state for clients list

**Context:**
`apps/admin/app/(app)/clients/page.tsx` renders a blank section when `clients.length === 0`. It looks broken in a new environment.

**What to do:**
In `apps/admin/app/(app)/clients/page.tsx`, replace the `<section className="space-y-4">` block's content so that when `clients.length === 0`, it renders:

```
A rounded-[1.75rem] border border-dashed border-slate-300 bg-slate-50 p-10 text-center block showing:
- Heading: "No clients yet"
- Subtext: "When a venue operator signs up, they will appear here."
```

When `clients.length > 0`, render the existing map loop unchanged.

Run `turbo run typecheck lint` — zero errors.

---

### Task 1.3 — Deduplicate `getStatusClasses` helper in admin

**Context:**
The `getStatusClasses(status: string)` function is copy-pasted identically in two files:

- `apps/admin/app/(app)/clients/page.tsx` (line 13)
- `apps/admin/app/(app)/clients/[tenantId]/page.tsx` (has the same function)

**What to do:**

1. Create `apps/admin/lib/status.ts` with the shared `getStatusClasses` function exported.
2. Replace the inline definitions in both page files with an import from `../../../lib/status` (or the correct relative path).
3. Run `turbo run typecheck lint` — zero errors.

---

## Phase 2 — Chatbot Polish (guest-facing, high demo value)

### Task 2.1 — Chat welcome / greeting card (empty state)

**Context:**
When a guest first opens the chat at `apps/web/app/[venueSlug]/chat/page.tsx`, the `messages.length === 0` branch currently only shows `<QuickPromptChips>`. There is no personal greeting. The `ChatWindow` component also has a generic dashed-border empty state inside the scroll area.

**What to do:**

1. In `apps/web/app/[venueSlug]/chat/page.tsx`, when `messages.length === 0` and `venue` is loaded, render a greeting card **above** the `<QuickPromptChips>` component (but inside the main column, below the header). The greeting card should:
   - Display a wave emoji or icon-free friendly greeting: `"Hi! I'm your {venue.name} guide."`
   - A one-line subtext: `"Ask me anything about the venue — I'll point you in the right direction."`
   - Use the existing glassmorphism style: `rounded-[2rem] border border-white/10 bg-slate-900/65 p-5 shadow-xl backdrop-blur mb-4`
   - Text in `text-slate-100` / `text-slate-300` matching the existing header style.
2. Remove the generic "Start with a quick prompt or ask your own question." dashed-border placeholder from inside `ChatWindow` (line 81–83 in `apps/web/components/ChatWindow.tsx`) — it is now redundant.
3. Run `turbo run typecheck lint` — zero errors.

---

### Task 2.2 — Venue-aware quick-prompt chips

**Context:**
`apps/web/components/QuickPromptChips.tsx` has 6 hardcoded generic prompts. The venue name and category are available in the parent page as `venue.name` and `venue.category`. We want the chips to feel specific to the venue.

**What to do:**

1. Update `QuickPromptChipsProps` to accept an optional `venueName?: string` and `venueCategory?: string` prop.
2. Replace the static `QUICK_PROMPTS` const with a function `buildPrompts(venueName?: string, venueCategory?: string): string[]` that returns 6 prompts. Use the venue name/category to personalize where natural:
   - `"What's worth seeing near me right now?"` (always)
   - `"Where should I go next?"` (always)
   - `"Where are the restrooms?"` (always)
   - `"What's good to eat or drink here?"` (always)
   - `venueName ? \`What makes ${venueName} special?\` : "What's the best part of this venue?"`
   - `venueCategory === 'ZOO' || venueCategory === 'AQUARIUM' ? "What animals can I see today?" : "What's good to do with kids?"`
3. In `apps/web/app/[venueSlug]/chat/page.tsx`, pass `venueName={venue.name}` and `venueCategory={venue.category ?? undefined}` to `<QuickPromptChips>`.
4. Update `apps/web/components/QuickPromptChips.test.tsx` so existing tests still pass (adjust for new props being optional).
5. Run `turbo run typecheck lint test` — zero errors/failures.

---

### Task 2.3 — Mobile PWA feel (web app manifest + viewport)

**Context:**
`apps/web/app/layout.tsx` exists. The chatbot is used on mobile devices inside venues and should feel like a native app.

**What to do:**

1. Open `apps/web/app/layout.tsx`. Add a `<meta name="theme-color" content="#0f172a" />` tag in the `<head>`.
2. Ensure the viewport meta tag includes `viewport-fit=cover`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`.
3. Create `apps/web/app/manifest.ts` (Next.js 14 Metadata API manifest route) exporting a default function that returns a `MetadataRoute.Manifest` object:
   ```ts
   {
     name: 'PathFinder',
     short_name: 'PathFinder',
     description: 'Your venue guide',
     start_url: '/',
     display: 'standalone',
     background_color: '#0f172a',
     theme_color: '#0f172a',
     icons: [
       { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
       { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
     ],
   }
   ```
4. Create `apps/web/public/icon-192.png` and `apps/web/public/icon-512.png` as simple placeholder PNGs (solid cyan #22d3ee squares) using a script or by copying any existing icon. If no image tooling is available, note in a comment that real icons must be dropped into `public/` before launch and skip the placeholder creation.
5. Add `<link rel="manifest" href="/manifest.webmanifest" />` to `apps/web/app/layout.tsx` head — or rely on Next.js auto-linking if using `manifest.ts`.
6. Add `apple-mobile-web-app-capable` and `apple-mobile-web-app-status-bar-style` meta tags for iOS.
7. Run `turbo run typecheck lint` — zero errors.

---

### Task 2.4 — Offline fallback page for chatbot

**Context:**
When guests lose connectivity inside a venue, the app shows a browser default error. We want a branded offline page.

**What to do:**

1. Create `apps/web/public/offline.html` — a minimal standalone HTML page (no external deps) with:
   - Dark background `#0f172a`, text `#e2e8f0`
   - PathFinder wordmark as plain text (no image required)
   - Heading: "You're offline"
   - Body: "Check your connection and try again. Once you're back online, tap below."
   - A reload button: `onclick="window.location.reload()"`
2. Create `apps/web/public/sw.js` — a minimal service worker that:
   - On `install`: caches `'/'` and `'/offline.html'`
   - On `fetch`: for navigation requests, if the network fails, serves `/offline.html`
   - For non-navigation requests: network-first, no cache fallback (keep it simple)
3. Register the service worker in `apps/web/app/layout.tsx` via an inline `<script>` in the body that calls `navigator.serviceWorker.register('/sw.js')` guarded by `'serviceWorker' in navigator`.
4. Run `turbo run typecheck lint` — zero errors.

---

## Phase 3 — Shareable Demo Link & Seed Data

### Task 3.1 — Demo venue seed script

**Context:**
There is no demo data. For sales demos, we need a venue with rich places that makes the chatbot feel impressive. The DB is Prisma/Postgres. The seed pattern is `packages/db/prisma/seed.ts` (or create it if it doesn't exist).

**What to do:**

1. Open or create `packages/db/prisma/seed.ts`.
2. Add (upsert-safe, re-runnable) seed data for a demo tenant + venue:
   - Tenant: `{ id: 'demo-tenant', name: 'PathFinder Demo', slug: 'pathfinder-demo', status: 'ACTIVE' }`
   - Venue: `{ name: 'Riverside Aquarium', slug: 'riverside-aquarium', category: 'AQUARIUM', description: 'A world-class aquarium in the heart of the city.', defaultCenterLat: 38.627, defaultCenterLng: -90.197, aiTone: 'FRIENDLY', aiGuideNotes: 'Always mention the Penguin Cove as a highlight. Remind guests that the 3pm shark feeding is a must-see.' }`
   - At least 12 Place records with realistic names, descriptions, lat/lng coordinates spread around the venue center, categories (EXHIBIT, DINING, RESTROOM, GIFT_SHOP, etc.), and `photoUrl: null` (no real images needed for seed).
   - Example places: Penguin Cove, Shark Tank, Amazon River exhibit, Jellyfish Gallery, Ray Touch Pool, Otter Habitat, Coral Reef Tunnel, Riverside Café, Aquarium Gift Shop, Family Restrooms (North), Family Restrooms (South), First Aid Station.
3. Add a `"seed": "tsx prisma/seed.ts"` script to `packages/db/package.json` if not present. Ensure `tsx` is available as a dev dependency.
4. In `packages/db/prisma/schema.prisma`, confirm the `datasource` has a `seed` key or add one: `seed = "npx tsx prisma/seed.ts"`.
5. Run `pnpm --filter @pathfinder/db seed` and confirm it completes without errors.
6. Run `turbo run typecheck` — zero errors.

---

### Task 3.2 — Shareable demo link (public venue page)

**Context:**
`apps/web/app/[venueSlug]/page.tsx` exists but we need to confirm it renders a useful landing page for the demo venue that links to the chat. This is the URL you email to prospects: `https://app.pathfinder.ai/riverside-aquarium`.

**What to do:**

1. Read `apps/web/app/[venueSlug]/page.tsx`. If it already renders the venue name, description, and a link to `/[venueSlug]/chat`, verify the copy and styling are polished and move on.
2. If it is a stub or bare redirect, build it out:
   - Server component that fetches venue by slug via tRPC caller (same pattern as other server pages in this repo).
   - Renders: venue name, category badge, description, a prominent CTA button: "Start your visit →" linking to `/[venueSlug]/chat`.
   - Uses the existing glassmorphism dark style matching the chat page header.
   - If venue is not found, show a not-found card (same pattern as `pageError` in the chat page).
3. The page must be fully accessible without a login — it calls a `publicProcedure`.
4. Run `turbo run typecheck lint` — zero errors.

---

## Phase 4 — Dashboard Analytics: Real Data

### Task 4.1 — "Top questions" analytics tRPC procedure

**Context:**
The analytics page at `apps/dashboard/app/(app)/analytics/page.tsx` shows session trends and weekly digests. We want to add a "Top questions guests asked this week" section. Guest messages are stored in the `AnalyticsEvent` table with `eventType = 'message.sent'` and the message text in `metadata`. The `AnalyticsEvent` model is in the Prisma schema.

**What to do:**

1. In `packages/api/src/routers/analytics.ts` (or create it under `packages/api/src/routers/` if it doesn't exist), add a new `tenantProcedure` called `getTopQuestions`:
   - Input: `z.object({ days: z.number().int().min(1).max(90).default(7) })`
   - Query: fetch `AnalyticsEvent` rows where `tenantId = ctx.activeTenantId`, `eventType = 'message.sent'`, `createdAt >= now - days`, ordered by `createdAt desc`, limit 200.
   - Extract the `message` field from each row's `metadata` JSON.
   - Group by message text (case-insensitive, trimmed), count occurrences, return top 10 sorted by count desc.
   - Return type: `Array<{ question: string; count: number }>`
2. Wire it into `appRouter` if not already present.
3. In `apps/dashboard/app/(app)/analytics/page.tsx`, call `caller.analytics.getTopQuestions({ days: 7 })` inside the existing `Promise.all`.
4. Render a new section below the session trend chart: "Top questions this week" — a numbered list of question + count badge pairs. If the array is empty, show: "No guest questions recorded yet."
5. Run `turbo run typecheck lint` — zero errors.

---

### Task 4.2 — Dashboard venue detail page polish

**Context:**
`apps/dashboard/app/(app)/venues/[venueId]/page.tsx` exists. Read it before starting. It likely shows basic venue info. We want it to feel like a real management surface.

**What to do:**
Read `apps/dashboard/app/(app)/venues/[venueId]/page.tsx` first. Then:

1. Ensure the page shows: venue name, slug, category, description, AI tone setting, featured place name (resolved from ID if set), guide notes (truncated to 3 lines with expand), and a count of active places.
2. Add a row of quick-action links at the top right:
   - "Edit venue" → `/venues/[venueId]/edit`
   - "AI Controls" → `/ai-controls`
   - "Add place" → `/venues/[venueId]/places/new`
3. Add a "Places" section below that lists all places for the venue: name, category badge, lat/lng in a small mono font, and an Edit link per row. Fetch via `caller.venue.getById` or a dedicated places list — use whatever procedure already exists.
4. All data fetching must use the server-side tRPC caller pattern (same as analytics page). No client-side data fetching on this page.
5. Run `turbo run typecheck lint` — zero errors.

---

## Phase 5 — Onboarding Flow Improvement

### Task 5.1 — Post-signup onboarding wizard (first venue setup)

**Context:**
`apps/dashboard/app/onboarding/page.tsx` currently handles org selection/creation via Clerk components. New tenants who just created their org have no venue yet. After org creation they land at `/` which shows an empty dashboard. We need to detect "no venue yet" and guide them through creating their first one.

**What to do:**

1. In `apps/dashboard/app/(app)/page.tsx` (the dashboard home server component), after fetching venues, if `venues.length === 0`, redirect to `/onboarding/setup` instead of rendering the dashboard.
2. Create `apps/dashboard/app/onboarding/setup/page.tsx` — a client component (needs interactivity) that:
   - Shows a 3-step progress indicator: "1. Name your venue → 2. Set your location → 3. Add your first place"
   - Step 1: Venue name + slug (auto-generated from name, editable) + category select (ZOO, AQUARIUM, MUSEUM, MALL, SPORTS_VENUE, OTHER)
   - Step 2: Lat/lng input — two number inputs labeled "Center latitude" and "Center longitude", with a note: "Use Google Maps to find your venue's center coordinates."
   - Step 3: Add one place — name + category + brief description. Label it "Add at least one place so your AI guide has something to talk about."
   - A "Create venue" button on step 3 that calls `api.venue.create` (via tRPC) and then calls `api.place.create` for the place, then redirects to `/venues/[venueId]`.
   - Use `react-hook-form` with `zodResolver`. Import Zod schemas from the tRPC router package — do not duplicate them.
3. The wizard should use the existing dashboard shell layout (`apps/dashboard/app/(app)/layout.tsx`) — place `setup/` inside `(app)/onboarding/setup/page.tsx`.
4. Run `turbo run typecheck lint` — zero errors.

---

## Phase 6 — Guest Analytics: What People Are Asking

### Task 6.1 — Store guest messages as analytics events

**Context:**
The `chat.send` procedure is in `packages/api/src/routers/chat.ts`. It currently calls `emitEvent` for some events. Guest messages (`message.sent`) need to include the message text in metadata so operators can see what guests ask most. Check `packages/analytics/src/events.ts` — `'message.sent'` and `'message.received'` are already registered event types.

**What to do:**

1. Read `packages/api/src/routers/chat.ts` fully.
2. In the `send` procedure, after a successful AI response:
   - Call `emitEvent('message.sent', { tenantId, venueId, sessionId: anonymousToken, metadata: { message: trimmed_input } })` — confirm the exact `emitEvent` signature from `packages/analytics/src/index.ts`.
   - Call `emitEvent('message.received', { tenantId, venueId, sessionId: anonymousToken, metadata: { responseLength: result.response.length, placesReturned: result.places.length } })`.
3. Both calls must be wrapped in try/catch (per CLAUDE.md §10 — analytics failures must never surface as 500s).
4. Both calls must happen **after** the mutation succeeds, not before.
5. Do not log the message content anywhere except the `AnalyticsEvent` metadata field. The structured logger must not log the message text.
6. Run `turbo run typecheck lint` — zero errors.

---

## Phase 7 — Multilingual Detection

### Task 7.1 — Detect guest language and respond in kind

**Context:**
`packages/api/src/lib/venue-context.ts` builds the system prompt passed to Claude. `packages/api/src/routers/chat.ts` calls `buildVenueSystemPrompt(...)` and passes the result to the Anthropic API as the system message. The guest message is available in the `send` procedure.

**What to do:**

1. In `packages/api/src/lib/venue-context.ts`, add the following instruction to the end of the string returned by `buildVenueSystemPrompt(...)`:

   ```
   LANGUAGE RULE: Detect the language of the guest's message. Always reply in the same language the guest uses. If the guest writes in Spanish, reply in Spanish. If French, reply in French. Do not switch languages mid-conversation unless the guest switches first. Default to English if the language is unclear.
   ```

2. That's the only change needed — Claude handles the detection and translation automatically. No external library or API call is needed.

3. Add a comment above the language rule in `venue-context.ts` explaining what it does so future maintainers understand it is intentional.

4. Run `turbo run typecheck lint` — zero errors.

---

## Done

After all 13 tasks above are complete:

- Run `turbo run typecheck lint test` from the repo root — all must pass.
- The demo venue (`/riverside-aquarium/chat`) should be usable end-to-end.
- The dashboard analytics page should show top questions.
- The admin console should handle zero-client state gracefully.
- New tenants completing signup should be guided through first venue setup.
- The chatbot should respond in the guest's language automatically.
