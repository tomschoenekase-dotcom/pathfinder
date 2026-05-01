# PathFinderOS — Codex Work Phases

> Self-contained implementation plan for AI-assisted development.
> Read `CLAUDE.md` and `docs/architecture.md` before starting any phase.
> Each phase is independent. Complete phases in any order.

---

## Project Context

PathFinderOS is a multi-tenant Next.js 14 App Router monorepo (`pnpm` workspaces + Turborepo).

| App                | Path             | Purpose                           |
| ------------------ | ---------------- | --------------------------------- |
| Public web + chat  | `apps/web`       | Guest-facing venue chat           |
| Operator dashboard | `apps/dashboard` | Tenant staff manage venues/places |
| Admin console      | `apps/admin`     | Platform owner ops                |

Shared packages: `packages/api` (tRPC routers), `packages/db` (Prisma + helpers), `packages/auth` (Clerk), `packages/ui` (shadcn components), `packages/analytics`, `packages/config`.

All business logic lives in `packages/api/src/routers/`. Never put logic in Next.js route handlers or React components. All inputs validated with Zod. Use `tenantProcedure` for tenant-scoped queries, `publicProcedure` for unauthenticated access. Throw `TRPCError`, never raw `Error`.

---

## Phase 1 — Dynamic `<title>` on the Chat Page

### Goal

The chat page currently shows "PathFinder" as the browser tab title for every venue. It should show the venue's name so the tab reads e.g. "STL Aquarium — PathFinder" and share previews include the venue name.

### Problem

`apps/web/app/[venueSlug]/chat/page.tsx` is a `'use client'` component. Next.js App Router does not allow `generateMetadata` exports from client components. The metadata must be exported from the parent layout.

### What to build

**File to edit:** `apps/web/app/[venueSlug]/chat/layout.tsx`

This is currently a thin server component that only exports a `viewport`. Add a `generateMetadata` export that:

1. Reads `params.venueSlug` from the segment params
2. Queries the database for the venue name by slug using a raw query (same pattern used in `packages/api/src/routers/chat.ts` — `$queryRaw` for cross-tenant public slug lookup)
3. Returns metadata with title `"{venue.name} — PathFinder"` and a description pulled from `venue.description`
4. Falls back to `"PathFinder"` if the venue is not found (don't throw — graceful fallback)

The layout receives `params: Promise<{ venueSlug: string }>` in App Router v14+.

Import `{ db }` from `@pathfinder/db`. Do not instantiate PrismaClient directly.

The query pattern (copy from chat.ts):

```ts
const [venue] = await db.$queryRaw<{ name: string; description: string | null }[]>`
  SELECT name, description FROM venues WHERE slug = ${venueSlug} AND is_active = true LIMIT 1
`
```

### Acceptance criteria

- Navigating to `/{slug}/chat` shows `"{Venue Name} — PathFinder"` in the browser tab
- If slug doesn't exist, tab shows `"PathFinder"` (no error)
- No change to the existing `viewport` export

---

## Phase 2 — Fix PWA Manifest

### Goal

The app has a service worker and install-prompt infrastructure but a naming mismatch prevents it from working. Fix it so the chat page is installable to a phone's home screen.

### The bugs

**Bug 1 — Wrong manifest filename:**
`apps/web/app/layout.tsx` line 23 links to `/manifest.webmanifest` but the actual file is `apps/web/public/manifest.json`. The browser never finds the manifest, so the PWA install criteria fails silently.

Fix: rename `apps/web/public/manifest.json` → `apps/web/public/manifest.webmanifest`.

**Bug 2 — Manifest missing the 512px icon:**
`apps/web/public/manifest.webmanifest` (after rename) currently only lists one icon (`icon.png`, 192×192). The 512×512 icon file already exists at `apps/web/public/icon-512.png` but is not listed. Chrome requires a 512px icon for the install prompt.

Fix: update the manifest icons array to include both sizes:

```json
"icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
]
```

**Bug 3 — Manifest `start_url` is too generic:**
`start_url: "/"` opens the placeholder homepage, not a venue chat. This is fine for now since venues are accessed by QR code, but add `"display": "standalone"` if not already present and set `"scope": "/"`.

### What to do

1. Rename `apps/web/public/manifest.json` to `apps/web/public/manifest.webmanifest`
2. Update its content with the corrected icons array and ensure `display: "standalone"` is set
3. Verify `apps/web/app/layout.tsx` still points to `/manifest.webmanifest` (it already does)
4. No code changes needed to the service worker — it already works correctly

### Acceptance criteria

- `GET /manifest.webmanifest` returns valid JSON with both icon sizes
- Chrome DevTools Application tab shows the manifest parsed without errors
- PWA install criteria passes (https + manifest + sw = installable)

---

## Phase 3 — Guest Questions Dashboard

### Goal

Operators currently have no visibility into what guests are actually asking their AI guide. Add a "Guest Questions" section to the dashboard analytics page that shows the top questions from the past 7 days. This is one of the primary selling points of the platform.

### What already exists

The tRPC query `analytics.getTopQuestions` already exists in `packages/api/src/routers/analytics.ts`. It returns an array of `{ question: string, count: number }` sorted by frequency, capped at 10 results, for the last 7 days. **No API changes needed.**

### What to build

**File to edit:** `apps/dashboard/app/(app)/analytics/page.tsx`

This is a server component that already calls tRPC procedures via `appRouter.createCaller(ctx)`.

Add a call to `caller.analytics.getTopQuestions({})` in the existing parallel data-loading section (alongside other `caller.*` calls).

Add a new section to the page UI below the existing content:

```
Guest Questions (Last 7 Days)
─────────────────────────────
A table or list showing each question and how many times it was asked.
If no questions: "No guest messages recorded yet."
```

Design guidelines (match the existing analytics page style):

- Use the same `rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm` card pattern
- Question text in `text-sm text-slate-900`
- Count shown as a badge: `inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700`
- If `count > 1`, show `{count}×` before or after the question
- Questions with count 1 need no badge (or show `1×` — be consistent)
- Cap the list at 10 (the API already does this)
- Add a note: `"Showing most-asked questions across all your venues in the last 7 days."`

### Acceptance criteria

- Analytics page shows a "Guest Questions" section
- Section is empty-state-safe (no crash when no events exist)
- Questions are sorted highest-count first (API handles this)
- No new tRPC procedures added — uses existing `analytics.getTopQuestions`

---

## Phase 4 — Rate Limiting on `chat.send`

### Goal

The `chat.send` tRPC procedure calls the Anthropic API on every invocation with no request limits. Before any real venue goes live, a single abusive session can generate unbounded API costs. Add per-session rate limiting using Redis (already available in the project).

### Infrastructure available

Redis is already configured: `REDIS_URL` is an env var read from `packages/config/src/env.ts`. IORedis is already a dependency in `packages/jobs`. The rate limiter should use a **sliding window** approach with two limits:

| Limit       | Key                                       | Window   | Max         |
| ----------- | ----------------------------------------- | -------- | ----------- |
| Per session | `ratelimit:chat:session:{anonymousToken}` | 1 hour   | 60 messages |
| Per venue   | `ratelimit:chat:venue:{venueId}`          | 1 minute | 30 messages |

The per-session limit prevents a single visitor from running up costs. The per-venue limit prevents a burst attack.

### What to build

**New file:** `packages/api/src/lib/rate-limit.ts`

Implement a sliding window rate limiter using Redis INCR + EXPIRE:

```ts
// Returns true if the request is allowed, false if rate limited
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean>
```

Use `ioredis` — import it as `import IORedis from 'ioredis'` and create a lazy singleton using `REDIS_URL` from `packages/config`. If `REDIS_URL` is not set, log a warning and return `true` (allow) — rate limiting is best-effort, not a hard dependency.

Pattern:

```
INCR key
if count === 1: EXPIRE key windowSeconds
if count > maxRequests: return false
return true
```

**File to edit:** `packages/api/src/routers/chat.ts`

In the `send` procedure, after validating the venue (step 1) and before calling the Anthropic API (step 6), add:

```ts
// Rate limit check
const [sessionAllowed, venueAllowed] = await Promise.all([
  checkRateLimit(`ratelimit:chat:session:${input.anonymousToken}`, 60, 3600),
  checkRateLimit(`ratelimit:chat:venue:${input.venueId}`, 30, 60),
])

if (!sessionAllowed || !venueAllowed) {
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: sessionAllowed
      ? 'This venue is receiving too many requests. Please try again in a moment.'
      : 'You have reached the message limit. Please try again later.',
  })
}
```

### Constraints

- If Redis is unavailable, fail open (allow the request) — never block a guest because Redis is down
- Do not import `ioredis` directly from any `apps/*` file — only from `packages/api/src/lib/rate-limit.ts`
- Do not use `packages/jobs/src/connection.ts` — that connection is BullMQ-configured. Create a separate minimal Redis client in the rate-limit module

### Acceptance criteria

- Sending > 60 messages from one `anonymousToken` in an hour returns `TOO_MANY_REQUESTS`
- When `REDIS_URL` is unset, chat works normally (no error thrown)
- The rate-limit module has unit tests covering: allowed request, blocked request, Redis-unavailable fallback

---

## Phase 5 — Marketing Homepage

### Goal

`apps/web/app/page.tsx` is currently a placeholder that says "Venue chat starts from a venue link." This is the public-facing homepage that potential customers see. Replace it with a real marketing landing page.

### Audience

Venue operators at zoos, aquariums, museums, malls, and sports venues. They are evaluating whether to pay for this product. The page needs to answer: what is it, why does it matter, and how do I get it.

### Content structure

Build a single-page marketing site at `apps/web/app/page.tsx`. It is a server component — no `'use client'` needed unless adding a form.

**Section 1 — Hero**

- Headline: "Your venue's AI guide. Trained on your places."
- Subhead: "Guests ask questions. PathFinder answers — with directions, hours, and recommendations specific to your venue. No generic chatbot. No setup headaches."
- CTA button: "Request a demo" → `mailto:` link or a `/contact` anchor (use `tomschoenekase@gmail.com` as the contact email)
- Secondary link: "See it in action →" → scroll to demo section

**Section 2 — How it works (3 steps)**

1. "Add your places" — You enter your venue's locations, exhibits, amenities, and hours
2. "The AI learns your venue" — PathFinder builds a guide that knows your specific layout, not generic directions
3. "Guests get instant answers" — Via QR code or link, on any phone, no app download required

**Section 3 — What guests can ask (example prompts)**
Show 4–6 example chat bubbles (just styled divs, no interactivity):

- "Where's the closest bathroom?"
- "What's good for kids under 5?"
- "How far is the elephant exhibit?"
- "What time does the café close?"
- "Is there seating near the entrance?"
- "What's the featured exhibit today?"

**Section 4 — Who it's for**
Target venue types with icons (use `lucide-react` only):

- Zoos & Aquariums
- Museums & Galleries
- Malls & Retail Centers
- Sports Venues & Stadiums
- Parks & Botanical Gardens

**Section 5 — CTA footer**
"Ready to give your guests a smarter experience?"
Button: "Get in touch" → `mailto:tomschoenekase@gmail.com`

### Design guidelines

- Dark background (`bg-slate-950`) for hero, white/slate-50 for content sections — matches existing web app aesthetic
- Use `text-cyan-400` / `text-cyan-300` for accent color (matches the chat UI)
- Mobile-first, responsive
- No external dependencies beyond what's already in `apps/web/package.json`
- Use `lucide-react` for any icons
- No images required — use CSS/tailwind shapes or emoji for illustrations if needed

### Acceptance criteria

- `GET /` returns the marketing page (not the placeholder)
- Page is responsive on 375px (iPhone SE) and 1280px (desktop)
- All CTAs link correctly
- No TypeScript errors, no `console.log`

---

## Phase 6 — Onboarding Flow Polish

### Goal

New operators land on the onboarding setup page (`apps/dashboard/app/(app)/onboarding/setup/page.tsx`) after signing up. The current flow works but feels unfinished. Polish it so a new customer can self-serve without needing help.

### Current state

The setup page (`apps/dashboard/app/(app)/onboarding/setup/page.tsx`) is a multi-step form that creates a venue and an initial place in one flow. Read this file fully before making changes.

### What to improve

**1. Step indicator**
Add a visible step progress indicator at the top of the form. The flow has approximately 3 logical steps (Venue info → First place → Done). Show which step the user is on: `Step 1 of 3 — Tell us about your venue`.

Use a simple horizontal step row:

```
● Venue info  ——  ○ First place  ——  ○ Done
```

Active step: filled circle + bold label. Completed: filled cyan. Upcoming: empty circle + muted.

**2. Field hints**
Add `<p className="mt-1 text-xs text-slate-500">` helper text below key fields:

- Venue name: "This is what guests will see in the chat header"
- Category: "Helps PathFinder tailor responses for your venue type"
- Latitude / Longitude: "The center point of your venue — guests' distances are measured from here. Use Google Maps to find coordinates: right-click any point on the map and copy the coordinates shown."
- Place name (first place step): "Add your most popular or iconic location first — you can add more after setup"
- Place coordinates: "Right-click in Google Maps to copy coordinates for this specific location"

**3. Success / completion screen**
After the form submits successfully, instead of immediately redirecting, show a brief "You're set up!" confirmation screen for 2 seconds, then redirect to `/venues/{venueId}?onboarded=1`. This gives the user a moment of satisfaction and prevents the jarring jump.

The confirmation screen (shown in place of the form):

```
✓  Your venue is live.
   PathFinder is ready to guide your guests.
   [Taking you to your dashboard...]
```

Use `emerald` colors. Use `setTimeout` with `router.push` for the redirect.

**4. Error display**
If the form submission fails, the error currently appears at the bottom of the form and may be below the fold. Move the error display to the top of the form (below the step indicator) so users don't miss it.

### Constraints

- Do not change the tRPC procedures — only the UI layer
- The form validation (Zod + react-hook-form) stays as-is
- Keep the existing `CreateVenueInput` and `CreatePlaceInput` schemas
- This is a `'use client'` component — no server-side data fetching needed

### Acceptance criteria

- Step indicator shows correct active step throughout the flow
- Helper text appears under each key field
- Successful submission shows the confirmation screen before redirecting
- Form errors appear at the top, not just the bottom
- No TypeScript errors
