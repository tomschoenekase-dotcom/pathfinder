# PathFinder — Codex Sprint 001

> Four sequential phases. Each phase is scoped to be completable in one Codex session.
> Read this document top-to-bottom before starting any phase.
> Complete phases in order — later phases depend on earlier ones.
> The monorepo uses `pnpm`. Run `pnpm turbo run typecheck` after each phase to verify no type errors were introduced.

---

## Project orientation

PathFinder is a multi-tenant SaaS platform for physical venues (zoos, aquariums, museums, malls, etc.). Guests use a chatbot at `apps/web` to navigate venues. Venue operators manage their content at `apps/dashboard`. Platform admins manage all tenants at `apps/admin`.

Key architecture rules:

- All business logic lives in `packages/api/src/routers/`. Never put logic in Next.js pages or route handlers.
- All tRPC procedures must use the correct base: `publicProcedure`, `tenantProcedure`, or `adminProcedure`.
- Import `{ db }` from `@pathfinder/db`. Never instantiate `PrismaClient` directly.
- Inputs validated with Zod. Errors thrown as `TRPCError`, never raw `Error`.
- `packages/auth` is the only place that imports from `@clerk/nextjs`.

---

## Phase 1 — Fix the broken dashboard + wire real stats

**Goal:** The dashboard overview currently has two hardcoded-zero stats and a broken navigation link. Fix all three so the dashboard reflects real data and every link works.

### Task 1.1 — Wire `activeAlerts` to real data

**File to edit:** `apps/dashboard/app/(app)/page.tsx`

The `stats.activeAlerts` value is currently hardcoded to `0`. Wire it to the real count.

The `operationalUpdate` router already exists at `packages/api/src/routers/operational-update.ts` and has a `list` procedure that returns all operational updates for the active tenant. Active alerts are those where `isActive: true`.

In `apps/dashboard/app/(app)/page.tsx`, add a call to `caller.operationalUpdate.list()` (alongside the existing `caller.venue.list()` call) and count the results where `isActive === true`. Set that count as `stats.activeAlerts`.

Also update the description text in `apps/dashboard/components/DashboardOverview.tsx` for the Active Alerts card — change `"Analytics coming soon."` to `"Closures and redirects currently published to guests."`.

### Task 1.2 — Wire `sessionsThisWeek` to real data

**File to edit:** `apps/dashboard/app/(app)/page.tsx`

The `stats.sessionsThisWeek` value is hardcoded to `0`. Wire it to real data.

The `analytics.getDailyStats` procedure (in `packages/api/src/routers/analytics.ts`) accepts `{ days: number }` and returns rows from the `DailyRollup` table. Each row has `{ date, metric, value }`. Rows where `metric === 'sessions'` contain daily session counts.

In `apps/dashboard/app/(app)/page.tsx`:

1. Call `caller.analytics.getDailyStats({ days: 7 })` to get the last 7 days.
2. Sum up all rows where `metric === 'sessions'` to get the total sessions this week.
3. Set that sum as `stats.sessionsThisWeek`.

Also update the description text in `apps/dashboard/components/DashboardOverview.tsx` for the Sessions this week card — change `"Analytics coming soon."` to `"Unique guest chat sessions opened in the last 7 days."`.

### Task 1.3 — Fix the broken `/ai-controls` link

**File to edit:** `apps/dashboard/components/DashboardOverview.tsx`

The quick actions array has an entry with `href: '/ai-controls'` pointing to a page that does not yet exist. Until Phase 3 builds that page, this link must not be a dead end.

Create a minimal placeholder page at `apps/dashboard/app/(app)/ai-controls/page.tsx` that:

- Uses the same page layout style as other dashboard pages (white background, slate-950 header section with cyan label, same rounded card styling visible throughout the app)
- Shows a header section: label `"AI Controls"`, heading `"Venue AI configuration"`, subtext `"Control how your venue's AI assistant behaves for guests. Customization options are coming soon."`
- Below the header, shows a single card with a `Bot` icon from `lucide-react`, heading `"Coming soon"`, and text `"Guide notes, featured place promotions, topic restrictions, and tone settings will appear here."`
- Does not import any tRPC client or make any data calls — it is purely static

No new router procedures are needed for this task. That comes in Phase 3.

### Verification for Phase 1

After completing Phase 1, run:

```
pnpm turbo run typecheck --filter=@pathfinder/dashboard
pnpm turbo run lint --filter=@pathfinder/dashboard
```

Both must pass with zero errors.

---

## Phase 2 — Polish the guest chatbot UI

**Goal:** The chatbot at `apps/web/app/[venueSlug]/chat/page.tsx` is the core product demo surface. Polish it so it feels more complete: better quick prompts, a visible loading/typing state, and a mobile-first layout pass.

### Task 2.1 — Improve quick prompt chips

**File to edit:** `apps/web/components/QuickPromptChips.tsx`

The current prompts are:

```
'What am I near?'
'What should I do next?'
'Where is the nearest bathroom?'
```

Replace the static `QUICK_PROMPTS` constant with a richer set of prompts that better represent what a real venue visitor would ask:

```ts
const QUICK_PROMPTS = [
  "What's worth seeing near me?",
  'Where should I go next?',
  'Where are the bathrooms?',
  "What's good to eat here?",
  "What's the best thing to do with kids?",
  "What are today's highlights?",
] as const
```

Also update the layout: the current chips are a flat `flex-wrap` row. Change it so chips display in a **2-column grid on mobile** and flow as a wrapped row on sm+ screens. Keep the existing button styling. The container section should have a slightly more prominent label — change `"Quick prompts"` to `"Start with a question"` and remove the `"Tap one to begin"` secondary label (it is redundant).

### Task 2.2 — Add a visible typing indicator while the AI is responding

**Files to edit:** `apps/web/components/ChatWindow.tsx`, `apps/web/components/MessageBubble.tsx`

Currently when a message is sent, the UI just goes silent while the AI thinks. Add a typing indicator that appears in the message list while `isLoading` is true.

In `apps/web/components/ChatWindow.tsx`:

- When `isLoading` is `true`, render a `TypingIndicator` component at the bottom of the message list, after the last message.
- The typing indicator should be positioned as an assistant message bubble (same alignment as assistant messages).

Create a new file `apps/web/components/TypingIndicator.tsx`:

- Renders a small pill/bubble in the assistant message style (dark background matching the assistant bubble style already used in `MessageBubble.tsx`)
- Contains three small dots (use `span` elements styled as small circles, e.g. `h-2 w-2 rounded-full bg-cyan-300`)
- The dots animate with a staggered fade/pulse using Tailwind's `animate-pulse` — apply `animation-delay` inline styles of `0ms`, `150ms`, `300ms` on the three dots respectively to create a wave effect
- Export it as `TypingIndicator`

Look at `apps/web/components/MessageBubble.tsx` first to match the assistant bubble visual style precisely.

### Task 2.3 — Mobile layout pass on the chat page

**File to edit:** `apps/web/app/[venueSlug]/chat/page.tsx`

The chat page currently uses `max-w-3xl` centering which works on desktop but does not make full use of mobile screen real estate. Make the following adjustments:

1. The outer `<main>` element has `px-4 pb-4 pt-6 sm:px-6`. Change `pb-4` to `pb-6` and add `safe-area-inset` handling for iOS notch: add `pb-[env(safe-area-inset-bottom,1.5rem)]` using Tailwind's arbitrary value syntax.

2. The header `<header>` card currently shows the raw `sessionId` value: `"Session {sessionId ?? 'starting'} {locationError ? ..."`. This is internal debug information that should not be visible to guests. Remove that entire `<p>` tag. The location error (if any) is already handled by the `LocationBanner` component below.

3. The venue `description` fallback text in the header currently says `'Ask where things are, what to do next, or what is nearby.'` — this is fine. No change needed here.

4. In the loading state (when `isBooting` is true), the current spinner is just centered text. Wrap it in the same rounded card style used for the venue-not-found state so both loading and error states feel visually consistent.

### Task 2.4 — Improve the chat input submit UX

**File to locate:** `apps/web/components/ChatWindow.tsx`

Find the send/submit button in `ChatWindow.tsx`. Currently, when `isLoading` is true, the button should be disabled. Verify this is the case — if it is not, add `disabled={isLoading}` to the button element. Also ensure the textarea/input is `disabled` during loading so the user cannot type a follow-up before the response arrives.

If the textarea currently has no `disabled` attribute when loading, add `disabled={isLoading}` to it.

This is a small but important UX fix — without it, guests can fire multiple messages simultaneously.

### Verification for Phase 2

After completing Phase 2, run:

```
pnpm turbo run typecheck --filter=@pathfinder/web
pnpm turbo run lint --filter=@pathfinder/web
```

Both must pass with zero errors.

---

## Phase 3 — Build the AI Controls page

**Goal:** Build a real, functional AI Controls feature. This is the most important differentiator between PathFinder and generic AI — venue operators can shape how their AI behaves. Phase 1 created a placeholder page. This phase replaces it with a working feature.

### What AI Controls does

Venue operators should be able to set:

1. **Guide notes** — Free-form text that gets injected into the AI system prompt. Used for things like "Always mention our new underwater tunnel", "Never recommend the food court on weekdays", "We close at 5pm on Sundays".
2. **Featured place** — The operator can pin one place to always be highlighted when relevant. Stored as a place ID with an optional promotional blurb.
3. **Tone** — A dropdown: `FRIENDLY` (default), `PROFESSIONAL`, `PLAYFUL`. Affects how the AI writes its responses.

This data belongs on the `Venue` model since it is per-venue, not per-tenant. Each venue has its own AI configuration.

### Task 3.1 — Add AI config fields to the Venue schema

**File to edit:** `packages/db/prisma/schema.prisma`

Add three new optional fields to the `Venue` model:

```prisma
aiGuideNotes    String?
aiFeaturedPlaceId String?
aiTone          String?   @default("FRIENDLY")
```

Then create and apply the migration:

```
cd packages/db
pnpm db:migrate --name add_venue_ai_config
```

No new table is needed — these fields live directly on `Venue`. This is not a tenanted table addition (Venue already has `tenantId`), so no changes to the tenant isolation middleware are required.

### Task 3.2 — Add tRPC procedures for AI Controls

**File to edit:** `packages/api/src/routers/venue.ts`

Add two new procedures to the `venueRouter`:

**`getAiConfig`** — `tenantProcedure`

- Input: `{ venueId: z.string().cuid() }`
- Returns: `{ aiGuideNotes, aiFeaturedPlaceId, aiTone }` for the venue
- Must include `where: { tenantId: ctx.session.activeTenantId }` in the query to enforce tenant isolation
- If the venue is not found or belongs to a different tenant, throw `TRPCError({ code: 'NOT_FOUND' })`

**`updateAiConfig`** — `tenantProcedure`, requires at minimum `MANAGER` role

- Input:
  ```ts
  z.object({
    venueId: z.string().cuid(),
    aiGuideNotes: z.string().max(2000).nullable().optional(),
    aiFeaturedPlaceId: z.string().cuid().nullable().optional(),
    aiTone: z.enum(['FRIENDLY', 'PROFESSIONAL', 'PLAYFUL']).optional(),
  })
  ```
- Updates only the fields that are provided (use `undefined` filtering — do not overwrite fields the caller didn't send)
- Must verify `venue.tenantId === ctx.session.activeTenantId` before updating
- After updating, call `emitEvent('venue.updated', { tenantId, venueId })` from `@pathfinder/analytics`
- Returns the updated `{ aiGuideNotes, aiFeaturedPlaceId, aiTone }`

For the role check, use `requireTenantRole(ctx, 'MANAGER')` from `@pathfinder/auth` — the same pattern used by other mutation procedures in `venue.ts`.

### Task 3.3 — Wire AI config into the chat system prompt

**File to edit:** `packages/api/src/routers/chat.ts`

The `chat.send` procedure currently builds a system prompt using venue name, description, and place context. Extend this to include the AI config fields.

In the `send` procedure, after fetching the venue, also fetch `venue.aiGuideNotes`, `venue.aiFeaturedPlaceId`, and `venue.aiTone`.

Update the system prompt construction:

1. If `aiGuideNotes` is non-null and non-empty, append a section to the system prompt:

   ```
   Operator guidance (follow these instructions):
   {aiGuideNotes}
   ```

2. If `aiFeaturedPlaceId` is set, look up that place by ID from the already-fetched place context (or fetch it if not present). Add a line to the system prompt:

   ```
   Featured highlight: When relevant, mention "{place.name}" — {featuredBlurb or place.description}.
   ```

3. The `aiTone` field maps to a tone instruction appended to the system prompt:
   - `FRIENDLY` → `"Respond in a warm, helpful, conversational tone."`
   - `PROFESSIONAL` → `"Respond in a clear, informative, professional tone."`
   - `PLAYFUL` → `"Respond in an enthusiastic, fun, engaging tone — suitable for families."`
   - Default to `FRIENDLY` if null.

These additions must be placed within the cached system prompt block (inside the `cache_control` anthropic block already present in the router) so they benefit from prompt caching.

### Task 3.4 — Build the AI Controls dashboard page

**Files to create/edit:**

- Replace `apps/dashboard/app/(app)/ai-controls/page.tsx` (the placeholder from Phase 1)
- Create `apps/dashboard/components/AiControlsForm.tsx`

**Page (`apps/dashboard/app/(app)/ai-controls/page.tsx`):**

This is a server component. It:

1. Fetches the list of venues via `caller.venue.list()`
2. If the tenant has no venues, renders a message: `"You need to create a venue before configuring AI controls."` with a link to `/venues/new`
3. If there is one or more venues, passes the venues array to `<AiControlsForm venues={venues} />`

If the tenant has multiple venues, the form will include a venue selector. Fetch the AI config for the first venue by default (the form handles switching client-side).

**Form component (`apps/dashboard/components/AiControlsForm.tsx`):**

This is a `'use client'` component. It receives `venues: { id: string, name: string }[]` as a prop.

The form has the following sections:

**Section 1 — Venue selector** (only shown if `venues.length > 1`)

- A `<select>` or set of tabs to pick which venue's AI config is being edited
- On change, fetches the AI config for the selected venue via the tRPC client

**Section 2 — Tone**

- Label: `"Response tone"`
- Description: `"Controls how the AI writes its responses to guests."`
- Three radio-style option cards (not a plain `<select>`), one for each tone value:
  - `FRIENDLY` — label `"Friendly"`, description `"Warm, helpful, conversational. Good for most venues."`
  - `PROFESSIONAL` — label `"Professional"`, description `"Clear and informative. Good for museums and educational venues."`
  - `PLAYFUL` — label `"Playful"`, description `"Enthusiastic and fun. Great for zoos, aquariums, and family attractions."`
- The selected option gets a highlighted border (e.g. `border-cyan-500 bg-cyan-50`)

**Section 3 — Guide notes**

- Label: `"Operator guide notes"`
- Description: `"These instructions are injected directly into the AI's context. Use them to highlight special events, set restrictions, or provide seasonal information."`
- A `<textarea>` with placeholder: `"e.g. The new butterfly exhibit opens this weekend. Always mention it when guests ask about new things to see. The food court closes at 4pm on weekdays."`
- Max 2000 characters. Show a character counter below the textarea.

**Section 4 — Save button**

- `"Save AI configuration"` button
- On submit, calls `trpc.venue.updateAiConfig.mutate(...)` with the current form values
- Show a success message `"AI configuration saved."` for 3 seconds after save, then clear it
- Disable the button while saving

Use the tRPC client pattern already used in other dashboard components. Look at `apps/dashboard/components/VenueForm.tsx` or `apps/dashboard/components/OperationalUpdateForm.tsx` for the correct pattern of how tRPC mutations are called from client components in this app.

Match the visual style of existing dashboard pages (white rounded cards, slate color palette, cyan accents).

### Verification for Phase 3

After completing Phase 3, run:

```
pnpm turbo run typecheck
pnpm turbo run lint
```

Both must pass across all packages with zero errors.

---

## Phase 4 — Build the Admin console

**Goal:** `apps/admin` currently renders a single line of text. Build a functional admin console with a proper shell, a client list, per-client status management, and digest triggering. All the tRPC procedures already exist in `packages/api/src/routers/admin/_admin.ts`.

### What exists already

- `apps/admin/app/(app)/layout.tsx` — enforces `PLATFORM_ADMIN` auth gate (do not modify)
- `apps/admin/app/(auth)/sign-in/[[...sign-in]]/page.tsx` — Clerk sign-in
- `apps/admin/app/api/trpc/[trpc]/route.ts` — tRPC handler
- `apps/admin/lib/trpc.ts` — tRPC client setup
- `apps/admin/middleware.ts` — route protection

The admin tRPC router (`packages/api/src/routers/admin/_admin.ts`) has these procedures:

- `admin.ping` — health check
- `admin.listClients` — returns all tenants with their active memberships and users
- `admin.createClient` — creates a tenant + user + owner membership
- `admin.updateClientStatus` — sets tenant status to `ACTIVE`, `SUSPENDED`, or `TRIAL`
- `admin.triggerDigest` — enqueues a weekly digest job for a specific tenant

### Task 4.1 — Add a navigation shell to the admin app

**Files to create:**

- `apps/admin/components/AdminShell.tsx`

**Edit:** `apps/admin/app/(app)/layout.tsx`

Create `AdminShell.tsx` as a `'use client'` component that wraps children in a layout with:

- A top navigation bar with:
  - Left side: `"PathFinder Admin"` in small bold uppercase text with a subtle separator, then nav links: `"Clients"` (href `/`), `"Platform"` (href `/platform` — this page will not exist yet, just a nav item)
  - Right side: A `<UserButton />` from `@clerk/nextjs` for the signed-in admin's account
- A `<main>` area below that renders `{children}` with `px-6 py-8 lg:px-10` padding
- Style: dark nav bar (`bg-slate-950 text-white`) consistent with the admin feel

Update `apps/admin/app/(app)/layout.tsx` to wrap children in `<AdminShell>` rather than the bare `<>` fragment.

Import `UserButton` from `@clerk/nextjs`. This is allowed because `apps/admin` layout files may import from `@clerk/nextjs` directly — only `packages/*` are restricted from doing so.

### Task 4.2 — Build the clients list page

**File to create:** `apps/admin/app/(app)/clients/page.tsx`
**File to edit:** `apps/admin/app/(app)/page.tsx` (redirect to `/clients`)

**`apps/admin/app/(app)/page.tsx`:**
Replace the single-line placeholder with a redirect:

```ts
import { redirect } from 'next/navigation'
export default function AdminHomePage() {
  redirect('/clients')
}
```

**`apps/admin/app/(app)/clients/page.tsx`:**

This is a server component. It:

1. Creates a tRPC server caller (look at how `apps/dashboard/app/(app)/page.tsx` does this — same pattern using `createTRPCContext` and `appRouter.createCaller`)
2. Calls `caller.admin.listClients()`
3. Renders a page with:

**Header section:** Dark (`bg-slate-950`) rounded card with label `"Platform Admin"`, heading `"Clients"`, subtext `"All venue operator tenants on the PathFinder platform."`. Also show a summary stat: total client count.

**Clients table/list:** For each tenant, render a card or table row showing:

- Tenant name (bold)
- Tenant slug (small text, styled like a monospace tag)
- Status badge: `ACTIVE` (green), `SUSPENDED` (red), `TRIAL` (yellow) — use color-coded `span` elements with rounded-full styling
- Number of active members (from `memberships.length`)
- Owner email — find the membership with role `OWNER` and show `membership.user.email` (or `"No owner"` if none)
- A `"Manage"` button that links to `/clients/{tenant.id}` (this detail page is built in the next task)

Use a clean card list layout (not an HTML `<table>`) to match the styling conventions in the rest of the platform. Each client gets its own rounded card.

### Task 4.3 — Build the client detail / management page

**File to create:** `apps/admin/app/(app)/clients/[tenantId]/page.tsx`
**File to create:** `apps/admin/components/ClientStatusForm.tsx`
**File to create:** `apps/admin/components/TriggerDigestButton.tsx`

**Page (`apps/admin/app/(app)/clients/[tenantId]/page.tsx`):**

Server component. Fetches `caller.admin.listClients()` and finds the client matching `params.tenantId`. If not found, render a not-found message with a back link.

Renders three sections:

**Section 1 — Client overview**

- Dark header card with tenant name, slug, status badge, created date
- List of members: each member's `user.email` and their `role`

**Section 2 — Status management (`<ClientStatusForm tenantId={tenant.id} currentStatus={tenant.status} />`)**

- This is a `'use client'` component in `apps/admin/components/ClientStatusForm.tsx`
- Shows the current status and three action buttons: `"Set Active"`, `"Set Trial"`, `"Set Suspended"`
- The button matching the current status is disabled
- On click, calls `trpc.admin.updateClientStatus.mutate({ tenantId, status })` via the tRPC client
- Shows a success/error message after the mutation completes
- After a successful status change, calls `router.refresh()` from `next/navigation` to re-fetch server data

**Section 3 — Weekly digest (`<TriggerDigestButton tenantId={tenant.id} />`)**

- `'use client'` component in `apps/admin/components/TriggerDigestButton.tsx`
- A single button: `"Trigger weekly digest"`
- On click, calls `trpc.admin.triggerDigest.mutate({ tenantId })`
- Shows loading state while the mutation is in-flight
- On success, shows: `"Digest job queued. It will process within the next few minutes."`
- On error, shows the error message

For both client components, use the tRPC client from `apps/admin/lib/trpc.ts`. Check that file first to understand how to instantiate the client — it should be similar to how `apps/dashboard` components use tRPC.

### Task 4.4 — Add a back-navigation link

On the client detail page (`/clients/[tenantId]`), add a `"← Back to clients"` link at the top using `next/link` pointing to `/clients`. Style it as small text with a left arrow character.

### Verification for Phase 4

After completing Phase 4, run:

```
pnpm turbo run typecheck
pnpm turbo run lint
```

Both must pass across all packages with zero errors.

---

## Cross-phase rules (apply to every phase)

- Do not add `console.log` statements. Use no logging in UI components.
- Do not create new packages or add new npm dependencies without confirming the dependency does not already exist in the monorepo.
- Do not modify `packages/db/src/middleware/tenant-isolation.ts`.
- Do not modify any existing migration file — only add new ones.
- All new tRPC procedures must use Zod for input validation.
- Use `lucide-react` for any icons. Do not add another icon library.
- Match the visual style of existing pages (rounded cards, slate/cyan color palette, `tracking-[0.28em]` uppercase labels). Do not introduce a different design language.
- Internal navigation uses `next/link`. Never `<a href>` for internal routes.
