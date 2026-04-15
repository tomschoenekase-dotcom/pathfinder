# Sprint 002 — Dashboard Polish & Reliability

> Implementation plan for Codex. Each phase is independent and can be assigned separately.
> Read `CLAUDE.md` before writing any code. All tRPC changes belong in `packages/api/src/routers/`.
> Do not introduce new patterns. Do not add dependencies.

---

## Phase 1 — Fix the N+1 Query on Venue List

**Problem:** `apps/dashboard/app/(app)/page.tsx` and `apps/dashboard/app/(app)/venues/page.tsx` both call `caller.venue.list()` and then loop over the result calling `caller.venue.getById({ id })` on each venue just to get `_count.places`. This is 1 + N database queries on every page load.

**Fix:** Update the `venue.list` procedure to include the place count in its return shape. Remove the per-venue `getById` calls from both pages.

### Exact changes

**`packages/api/src/routers/venue.ts` — `list` procedure**

Add `_count: { select: { places: true } }` to the Prisma `findMany` call inside the `list` procedure so each venue row already includes its place count.

**`apps/dashboard/app/(app)/page.tsx`**

- Remove the `venue.getById` `Promise.all` loop (lines 27–29).
- Replace the `totalPlaces` calculation to read `venue._count.places` from the `venue.list()` result directly.
- Remove the `VenueItem` type alias — it is only used to type the now-deleted loop.

**`apps/dashboard/app/(app)/venues/page.tsx`**

- Remove the `venuesWithCounts` `Promise.all` loop (lines 19–28).
- Replace it with `const venuesWithCounts = venues.map(v => ({ ...v, placeCount: v._count.places }))`.
- Remove the `VenueItem` type alias.

**Expected result:** Both pages make 2–3 parallel queries instead of 2 + N.

---

## Phase 2 — Remove the Broken Settings Link

**Problem:** `DashboardShell.tsx` includes a `/settings` navigation item (line 29) that links to a page that does not exist. Users clicking it get a Next.js 404.

**Fix:** Remove the Settings entry from the `navigationItems` array in `apps/dashboard/components/DashboardShell.tsx`. Also remove the `Settings` icon import from `lucide-react` if it is no longer used after this change.

```ts
// Remove this entry from navigationItems:
{ href: '/settings', label: 'Settings', icon: Settings },
```

No other files need to change.

---

## Phase 3 — Make Dashboard Stat Cards Clickable

**Problem:** The four stat cards on the overview page (Venues, Total Places, Active Alerts, Sessions this week) are static `<article>` elements. Users naturally expect them to be clickable — "Active Alerts: 3" should go to `/operational-updates`, "Sessions this week" should go to `/analytics`, etc.

**Fix:** In `apps/dashboard/components/DashboardOverview.tsx`, convert each stat card from an `<article>` to a `<Link>` (from `next/link`) with an appropriate `href`. Add a hover state so users know they're interactive.

### Card → destination mapping

| Card               | href                   |
| ------------------ | ---------------------- |
| Venues             | `/venues`              |
| Total Places       | `/venues`              |
| Active Alerts      | `/operational-updates` |
| Sessions this week | `/analytics`           |

### Style change

Add `transition hover:border-cyan-200 hover:shadow-md` to each card's className. Wrap the `<article>` content in a `<Link>` — or replace the `<article>` with a `<Link>` that has `className` including `block` plus the existing card classes.

Do not change the card content or layout — only the wrapper element and hover style.

---

## Phase 4 — Add Active/Inactive Status to the Places Table

**Problem:** The places table in `apps/dashboard/app/(app)/venues/[venueId]/page.tsx` (lines 179–218) shows Name, Category, Coordinates, and Action — but not whether each place is active. A venue operator can't see which places the chatbot is currently using without opening each edit form.

**Fix:** Add a Status column to the places table.

### Exact changes in `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`

Add a `<th>` header cell between Category and Coordinates:

```html
<th className="px-6 py-3 font-medium">Status</th>
```

Add the corresponding `<td>` in each row, between the category cell and the coordinates cell:

```tsx
<td className="px-6 py-4 align-top">
  <span
    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
      place.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
    }`}
  >
    {place.isActive ? 'Active' : 'Inactive'}
  </span>
</td>
```

The `place.isActive` field is already present in the `caller.place.list()` result — no API change needed.

---

## Phase 5 — Fix AI Controls Link on Venue Detail Page

**Problem:** The "AI Controls" button in `apps/dashboard/app/(app)/venues/[venueId]/page.tsx` (line 106–110) links to `/ai-controls` without any venue context. If the tenant has multiple venues, the user lands on the AI Controls page showing the first venue, not the one they just came from.

The `AiControlsForm` component in `apps/dashboard/components/AiControlsForm.tsx` already reads its initial venue from `initialVenueId` which is set server-side in `apps/dashboard/app/(app)/ai-controls/page.tsx`.

**Fix — two parts:**

**Part A:** Update the venue detail link to pass the venue as a query param:

```tsx
// In apps/dashboard/app/(app)/venues/[venueId]/page.tsx, line 107
href={`/ai-controls?venue=${venue.id}`}
```

**Part B:** Update `apps/dashboard/app/(app)/ai-controls/page.tsx` to read the `venue` query param and use it to select the initial venue (instead of always defaulting to `venues[0]`).

The page already receives `searchParams` as a prop (it's a server component). Read `searchParams.venue` and use it as `initialVenueId` if it matches one of the fetched venues — otherwise fall back to `venues[0].id` as before. Pass the resolved `initialVenueId` to `<AiControlsForm>`.

No changes needed to `AiControlsForm` itself — it already accepts `initialVenueId`.

---

## Phase 6 — Fix Stale Copy in DashboardOverview

**Problem:** The hero section in `apps/dashboard/components/DashboardOverview.tsx` (line 50–52) contains placeholder copy written before analytics and operational tools were live:

> "Monitor your venue footprint, keep place content current, and prepare for analytics and operational tooling as they come online."

**Fix:** Replace the description text with copy that reflects the current state of the product. Suggested replacement:

> "Monitor guest activity, publish operational alerts, and fine-tune the AI guide for each of your venues."

No structural changes — one string replacement only.

---

## Phase 7 — Context-Aware Quick Actions

**Problem:** The Quick Actions section in `apps/dashboard/components/DashboardOverview.tsx` always shows the same three actions (Add a Venue, Create Operational Alert, Manage AI Controls) regardless of what the tenant has already set up. A tenant with 5 venues doesn't need to be nudged to "Add a Venue" — they need to add places or publish alerts.

**Fix:** Make the Quick Actions conditional on the `stats` prop which is already passed to this component.

### Logic

Replace the static `quickActions` array with a function `getQuickActions(stats)` that returns the most relevant actions:

```ts
function getQuickActions(stats: DashboardOverviewProps['stats']) {
  const actions = []

  if (stats.venues === 0) {
    // Shouldn't reach here (page.tsx redirects to onboarding) but include as safety
    actions.push({
      href: '/venues/new',
      label: 'Create your first venue',
      description: 'Set up a venue to get started.',
      icon: Building2,
    })
  } else if (stats.totalPlaces < 5) {
    actions.push({
      href: '/venues',
      label: 'Add places to your venue',
      description: 'The more places you add, the better the chatbot answers.',
      icon: MapPin,
    })
  } else {
    actions.push({
      href: '/venues/new',
      label: 'Add another venue',
      description: 'Expand your footprint with a new venue.',
      icon: Building2,
    })
  }

  actions.push({
    href: '/operational-updates/new',
    label: 'Publish an alert',
    description: 'Let guests know about closures or changes right now.',
    icon: Megaphone,
  })

  actions.push({
    href: '/ai-controls',
    label: 'Tune the AI guide',
    description: 'Adjust tone, featured places, and guide notes.',
    icon: Bot,
  })

  return actions
}
```

Add `MapPin` to the lucide-react import. Remove `Sparkles` from the import if it is no longer used after this change (check — it's currently used on the section icon; replace it with `Zap` or keep it).

Pass `stats` into this function where `quickActions.map(...)` is currently called.

---

## Phase 8 — UI Polish: Reduce "AI-Generated" Feel

**Problem:** The dashboard has several visual tells that make it read as template output rather than a considered design: every section uses the same `text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700` eyebrow label; every card has the same structure and corner radius; the dark hero banner is copy-pasted across three pages; the sidebar active state (cyan-400) is jarring; the VenueCard isn't clickable even though it has a button inside it.

These changes are purely in the dashboard app. Do not touch `packages/ui`. Do not change layout structure, only visual details and copy.

### 8a — Sidebar

File: `apps/dashboard/components/DashboardShell.tsx`

- Change the active nav item from `bg-cyan-400 text-slate-950` to `bg-slate-800 text-white` — a subtler, dark-mode-appropriate active state.
- Add `border-l-2 border-cyan-400` to the active item to give it a visual indicator without the jarring full background change.
- Change the "PathFinder" wordmark from `text-cyan-400` to `text-white` with a small cyan dot or just plain white — the cyan-on-dark is fine but the all-caps tracking feels heavy. Change to normal case: `PathFinder` with `text-sm font-semibold`.

### 8b — Overview page hero

File: `apps/dashboard/components/DashboardOverview.tsx`

- Remove the `rounded-[2rem] bg-slate-950 px-8 py-10` dark hero section entirely. Replace it with a simpler page header: the org name as an `<h1>` in `text-3xl font-semibold text-slate-950` with the description below it in `text-sm text-slate-500`. No dark card.
- This removes the pattern that is duplicated across three pages and makes the overview feel like a dashboard rather than a landing page.

### 8c — Stat cards

File: `apps/dashboard/components/DashboardOverview.tsx`

- Add a small icon to each stat card (top-left, `h-5 w-5`, muted color) to give each card a distinct identity:
  - Venues → `Building2` in `text-slate-400`
  - Total Places → `MapPin` in `text-slate-400`
  - Active Alerts → `Megaphone` — use `text-amber-500` when `stats.activeAlerts > 0`, `text-slate-400` when 0
  - Sessions this week → `Users` in `text-slate-400`
- Move the stat number to below the label (current order: label → number → description). Change stat number size from `text-4xl` to `text-3xl` — slightly less oversized.

### 8d — Eyebrow labels

The `text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700` pattern appears on virtually every section across every page. It creates visual monotony.

Audit and reduce: only keep eyebrow labels on sections where they provide navigation context (e.g., the analytics page sections). Remove them from:

- The Quick Actions section header in `DashboardOverview.tsx` (the `<h2>` is sufficient)
- The stat card grid (no eyebrow needed above it)

Files: `apps/dashboard/components/DashboardOverview.tsx` only for this phase — do not touch analytics or other pages.

### 8e — VenueCard clickability

File: `apps/dashboard/components/VenueCard.tsx`

The entire card should be clickable, not just the "Open venue" button inside it. Wrap the card content in a `<Link href={"/venues/${venue.id}"}>` and remove the standalone button at the bottom. Add `hover:shadow-md hover:border-slate-300 transition-shadow` to the card's outer className.

### 8f — Places table row hover

File: `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`

Add `hover:bg-slate-50 transition-colors` to each `<tr>` in the places table so rows respond to hover. This is a tiny change but makes the table feel more interactive.

### 8g — Page header consistency

Currently some pages have a dark hero (`bg-slate-950`) and most don't. This inconsistency makes the dashboard feel unfinished.

**Remove the dark hero section from the Analytics page** (`apps/dashboard/app/(app)/analytics/page.tsx`, lines 279–290). Replace it with the same simple header pattern: `<h1>` + subtitle paragraph, no card wrapper. The analytics content sections below already have their own headers.

Do not add a dark hero to pages that don't have one. The goal is to remove the pattern, not spread it.

---

## Delivery Notes for Codex

- Phases 1–7 are mechanical changes with exact file/line targets. Complete them in order.
- Phase 8 involves judgment calls on visual design — follow the instructions precisely and do not improvise additional style changes beyond what is listed.
- Run `turbo run typecheck` and `turbo run lint` after each phase. Do not proceed to the next phase if either fails.
- Do not add new npm packages.
- Do not modify any files in `packages/api` except in Phase 1 (`venue.ts` router only).
- Do not modify `packages/db`, `packages/auth`, or any worker code.
- All changes are in `apps/dashboard/` and `packages/api/src/routers/venue.ts` only.
