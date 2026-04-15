# Sprint 003 — Dashboard Usability

> Implementation plan for Codex. Each phase is independent and can be assigned separately.
> Read `CLAUDE.md` before writing any code. All tRPC changes belong in `packages/api/src/routers/`.
> Do not introduce new patterns. Do not add dependencies.

---

## Phase 1 — Place Form: Essential vs Advanced Fields

**Problem:** `apps/dashboard/components/PlaceForm.tsx` renders all 11 fields at once. A new operator staring at "Importance score", "Tags", "Long description", and "Photo URL" has no idea what the chatbot actually needs. The required fields to get a working chatbot entry are: Name, Type, Short description, Latitude, and Longitude. Everything else is supplementary.

**Fix:** Split the form into two sections — required fields always visible, optional fields hidden behind a `<details>` element labelled "Advanced options". No logic changes — only the layout of the form fields changes.

### Exact changes in `apps/dashboard/components/PlaceForm.tsx`

The current form has one flat `<div className="grid gap-5 sm:grid-cols-2">` containing all fields. Replace it with two blocks:

**Block 1 — Essential fields (always visible), inside the existing grid:**

- Name
- Type (with datalist)
- Short description (`sm:col-span-2`)
- Latitude
- Longitude

**Block 2 — Advanced options, wrapped in a `<details>` element below Block 1:**

```tsx
<details className="group rounded-2xl border border-slate-200">
  <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-slate-700">
    <span>Advanced options</span>
    <span className="text-xs text-slate-400 group-open:hidden">Show</span>
    <span className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
  </summary>
  <div className="grid gap-5 border-t border-slate-200 px-5 pb-5 pt-5 sm:grid-cols-2">
    {/* Long description, Tags, Importance score, Area name, Hours, Photo URL, isActive checkbox */}
  </div>
</details>
```

Move these fields into Block 2 (advanced):

- Long description (`sm:col-span-2`)
- Tags
- Importance score
- Area name
- Hours
- Photo URL (`sm:col-span-2`)
- isActive checkbox (`sm:col-span-2`)

In edit mode, if any advanced field has a non-empty value, add `defaultOpen` to the `<details>` element so operators editing an existing place don't have to expand it manually:

```tsx
const hasAdvancedValues =
  mode === 'edit' &&
  Boolean(
    values.longDescription ||
    values.tags.length > 0 ||
    values.importanceScore !== 0 ||
    values.areaName ||
    values.hours ||
    values.photoUrl,
  )
```

Pass `open={hasAdvancedValues}` to the `<details>` element. Note: `hasAdvancedValues` should be derived after `reset()` is called in the `useEffect` (i.e., use a state variable that is set when the place loads, not a variable read from the hook's current render values — read the form values via `watch()` or track with a separate `useState`).

The simplest approach: add `const [showAdvanced, setShowAdvanced] = useState(false)` and set it to `true` inside the `useEffect` after `reset()` when any advanced field is non-empty. Use `open={showAdvanced}` and `onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}` on the `<details>`.

No changes to form validation, submission logic, or the tRPC calls.

---

## Phase 2 — Delete Place and Venue UI

**Problem:** Users who create a test place or duplicate venue have no way to remove it. The `venue.delete` tRPC procedure already exists at `packages/api/src/routers/venue.ts`. A `place.delete` procedure needs to be added.

### Part A — Add `place.delete` procedure

File: `packages/api/src/routers/place.ts`

Add a `delete` procedure using `tenantProcedure.use(requireRole('MANAGER'))`:

```ts
delete: tenantProcedure
  .use(requireRole('MANAGER'))
  .input(z.object({ id: z.string().cuid() }))
  .mutation(async ({ ctx, input }) => {
    const tenantId = ctx.session.activeTenantId

    const place = await ctx.db.place.findFirst({
      where: { id: input.id, tenantId },
      select: { id: true },
    })

    if (!place) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Place not found' })
    }

    await ctx.db.place.deleteMany({ where: { id: input.id, tenantId } })

    return { id: input.id }
  }),
```

Use `deleteMany` (not `delete`) to keep the tenantId in the where clause — same pattern as `venue.delete`.

### Part B — Delete button on Edit Place page

File: `apps/dashboard/components/PlaceForm.tsx`

In edit mode only, add a delete button below the save button. It is a separate `<button type="button">` — not inside the form submit flow.

Behavior:

1. On click, call `window.confirm('Delete this place? This cannot be undone.')`.
2. If confirmed, call `client.place.delete.mutate({ id: placeId })`.
3. On success, call `router.push(`/venues/${venueId}`)` and `router.refresh()`.
4. On error, set `formError` with the error message.
5. Show a disabled/loading state on the button while the delete is in flight (use a separate `isDeleting` state boolean).

Button styling — visually distinct from the save button, low prominence to avoid accidental clicks:

```tsx
<button
  type="button"
  disabled={isDeleting || isSubmitting}
  onClick={handleDelete}
  className="inline-flex min-h-11 items-center rounded-full border border-rose-200 px-5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
>
  {isDeleting ? 'Deleting...' : 'Delete place'}
</button>
```

Place both buttons in a `<div className="flex items-center justify-between gap-4">` — save button on the right, delete on the left.

### Part C — Delete button on Edit Venue page

File: `apps/dashboard/components/VenueForm.tsx`

Same pattern as Part B, but calling `client.venue.delete.mutate({ id: venueId })` and redirecting to `/venues` on success.

Add a note above the button explaining the constraint that already exists in the router — venues with places cannot be deleted:

```tsx
<p className="text-xs text-slate-500">
  Venues with places cannot be deleted. Remove all places first.
</p>
```

This matches the `TRPCError` the router already throws (`'Remove all POIs before deleting a venue'`), so the error message will also surface in `formError` if the user somehow bypasses the note.

---

## Phase 3 — Server-Render Edit Forms

**Problem:** Both edit forms (`VenueForm` in edit mode, `PlaceForm` in edit mode) fetch their data in a `useEffect` after client-side hydration. The result is a blank form that flickers to populated. The page components that render these forms are already server components — they should fetch the data and pass it as props.

### Part A — Edit Venue page

**Step 1:** Convert `apps/dashboard/components/VenueForm.tsx` to accept an optional `initialValues` prop:

```ts
type VenueFormProps = {
  mode: 'create' | 'edit'
  venueId?: string
  initialValues?: {
    name: string
    slug: string
    description: string
    guideNotes: string
    category: string
    defaultCenterLat: number | undefined
    defaultCenterLng: number | undefined
  }
}
```

When `initialValues` is provided, pass it directly to `useForm` as `defaultValues` and skip the `useEffect` data-fetching entirely. Keep the `useEffect` as a fallback for when `initialValues` is not provided (so the component remains backward-compatible with the onboarding flow which constructs the form without server data).

**Step 2:** Update `apps/dashboard/app/(app)/venues/[venueId]/edit/page.tsx` to be an async server component that fetches the venue and passes `initialValues`:

```tsx
import { notFound } from 'next/navigation'
import { TRPCError } from '@trpc/server'
import Link from 'next/link'
import { appRouter, createTRPCContext } from '@pathfinder/api'
import { VenueForm } from '../../../../../components/VenueForm'

type EditVenuePageProps = {
  params: Promise<{ venueId: string }>
}

async function createCaller() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/venues/edit'),
  })
  return appRouter.createCaller(ctx)
}

export default async function EditVenuePage({ params }: EditVenuePageProps) {
  const { venueId } = await params
  const caller = await createCaller()

  try {
    const venue = await caller.venue.getById({ id: venueId })

    return (
      <main className="min-h-screen bg-slate-50 px-6 py-10">
        <div className="mx-auto max-w-4xl space-y-6">
          <Link
            href={`/venues/${venueId}`}
            className="text-sm font-medium text-cyan-700 hover:text-cyan-800"
          >
            Back to venue
          </Link>
          <VenueForm
            mode="edit"
            venueId={venueId}
            initialValues={{
              name: venue.name,
              slug: venue.slug,
              description: venue.description ?? '',
              guideNotes: venue.guideNotes ?? '',
              category: venue.category ?? '',
              defaultCenterLat: venue.defaultCenterLat ?? undefined,
              defaultCenterLng: venue.defaultCenterLng ?? undefined,
            }}
          />
        </div>
      </main>
    )
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') {
      notFound()
    }
    throw error
  }
}
```

Remove `'use client'` from the edit page — it is now a server component. `VenueForm` stays as a client component.

### Part B — Edit Place page

Same pattern. Update `apps/dashboard/components/PlaceForm.tsx` to accept `initialValues` and skip the `useEffect` fetch when it is provided.

Update `apps/dashboard/app/(app)/venues/[venueId]/places/[placeId]/edit/page.tsx` from a client component to an async server component that fetches the place via `caller.place.getById` and passes `initialValues` to `<PlaceForm>`.

The `initialValues` shape matches the existing `mapPlaceToValues` function already in `PlaceForm.tsx` — extract that mapping logic to the server component so `PlaceForm` only needs to accept the already-mapped values.

---

## Phase 4 — Public Chat URL on Venue Detail

**Problem:** The whole product is a guest-facing chatbot but nowhere in the dashboard is the chat URL shown. Venue operators need to know the URL to share with guests or embed it.

The public chat URL pattern is: `{NEXT_PUBLIC_WEB_URL}/{venue.slug}/chat`

### Environment variable

The web app URL needs to be accessible from the dashboard. Add `NEXT_PUBLIC_WEB_URL` to `apps/dashboard/.env.example` (and ensure it is set in the Railway/deployment environment). If it is already defined, use it. If not, use a placeholder approach: derive the URL in the page since the slug is known.

### Changes in `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`

Add a new card to the metadata section (the `grid gap-4 md:grid-cols-2 xl:grid-cols-3` section). Place it first in the grid, spanning full width (`md:col-span-2 xl:col-span-3`) to make it visually prominent:

```tsx
<article className="md:col-span-2 xl:col-span-3 rounded-[1.75rem] border border-slate-200 bg-white p-6 shadow-sm">
  <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Guest chat URL</p>
  <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <p className="font-mono text-sm text-slate-700 break-all">
      {process.env.NEXT_PUBLIC_WEB_URL ?? 'https://your-domain.com'}/{venue.slug}/chat
    </p>
    <CopyUrlButton url={`${process.env.NEXT_PUBLIC_WEB_URL ?? ''}/${venue.slug}/chat`} />
  </div>
</article>
```

Create a small client component `apps/dashboard/components/CopyUrlButton.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy()
      }}
      className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
      ) : (
        <Copy className="h-4 w-4" aria-hidden="true" />
      )}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
```

Import and render `<CopyUrlButton>` in the venue detail page. Since the page is a server component and `CopyUrlButton` is a client component, this is valid — the server component passes the URL string as a prop.

---

## Phase 5 — Operational Updates: Show Past Alerts

**Problem:** `OperationalUpdatesList` filters to only `isActive && not expired` alerts. Once an alert is deactivated or expires it disappears entirely. Operators have no way to review what was published.

### Changes in `apps/dashboard/components/OperationalUpdatesList.tsx`

**Step 1:** Change `initialUpdates` to include all updates (active and inactive), not just active ones. The server already passes all results from `caller.operationalUpdate.list()` — the filtering to active-only happens in `visibleUpdates` inside the component, so no API change is needed.

**Step 2:** Add a `pastUpdates` derived value alongside `visibleUpdates`:

```ts
const pastUpdates = useMemo(
  () => updates.filter((update) => !update.isActive || new Date(update.expiresAt).getTime() <= now),
  [now, updates],
)
```

**Step 3:** Add a collapsible "Past alerts" section below the active alerts list, only rendered when `pastUpdates.length > 0`:

```tsx
{
  pastUpdates.length > 0 && (
    <details className="mt-8 group">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[1.75rem] border border-slate-200 bg-slate-50 px-5 py-4">
        <span className="text-sm font-medium text-slate-700">
          Past alerts ({pastUpdates.length})
        </span>
        <span className="text-xs text-slate-400 group-open:hidden">Show</span>
        <span className="hidden text-xs text-slate-400 group-open:inline">Hide</span>
      </summary>
      <div className="mt-3 space-y-3">
        {pastUpdates.map((update) => {
          const config = severityConfig[update.severity]
          const Icon = config.icon
          return (
            <article
              key={update.id}
              className="rounded-[1.75rem] border border-slate-200 bg-white p-5 opacity-60"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ${config.badge}`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {config.label}
                </span>
                <span className="text-sm text-slate-500">{update.venue.name}</span>
              </div>
              <p className="mt-3 text-sm font-medium text-slate-700">{update.title}</p>
              <p className="mt-1 text-xs text-slate-400">
                Expired {new Date(update.expiresAt).toLocaleString()}
              </p>
            </article>
          )
        })}
      </div>
    </details>
  )
}
```

The past alert cards are intentionally simplified (no deactivate button, reduced opacity) to keep visual focus on the active alerts.

---

## Phase 6 — Onboarding Completion: Post-Setup Nudge

**Problem:** After the 3-step onboarding wizard completes, `router.push(`/venues/${venue.id}`)` drops the operator on the venue detail page. There's no acknowledgement that setup is done or guidance on what to do next. The operator lands on a page showing 1 place and no context.

### Changes in `apps/dashboard/app/(app)/onboarding/setup/page.tsx`

**Step 1:** Instead of routing directly to the venue page on success, route to `/venues/${venue.id}?onboarded=1`.

**Step 2:** In `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`, read `searchParams.onboarded`. If present, render a dismissible banner above the metadata cards:

Add `searchParams` to the page props:

```ts
type VenueDetailPageProps = {
  params: Promise<{ venueId: string }>
  searchParams: Promise<{ onboarded?: string }>
}
```

Read it in the component:

```ts
const { venueId } = await params
const { onboarded } = await searchParams
const justOnboarded = onboarded === '1'
```

Render the banner when `justOnboarded` is true, before the metadata cards section:

```tsx
{
  justOnboarded && (
    <section className="rounded-[1.75rem] border border-emerald-200 bg-emerald-50 px-6 py-5">
      <p className="text-sm font-semibold text-emerald-800">Your venue is set up.</p>
      <p className="mt-1 text-sm leading-6 text-emerald-700">
        Add more places to improve the AI guide, then share the chat URL with your guests.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          href={`/venues/${venueId}/places/new`}
          className="inline-flex min-h-9 items-center rounded-full bg-emerald-700 px-4 text-sm font-medium text-white transition hover:bg-emerald-800"
        >
          Add more places
        </Link>
        <Link
          href="/ai-controls"
          className="inline-flex min-h-9 items-center rounded-full border border-emerald-300 bg-white px-4 text-sm font-medium text-emerald-700 transition hover:bg-emerald-50"
        >
          Configure AI guide
        </Link>
      </div>
    </section>
  )
}
```

The banner is not interactive/dismissible — it only shows when the `?onboarded=1` query param is present. Navigating away and back to the venue page without that param will not show it again, which is the correct behavior.

---

## Phase 7 — Analytics Chart: Y-Axis Labels

**Problem:** The session trend SVG chart in `apps/dashboard/app/(app)/analytics/page.tsx` has no Y-axis labels. You can see the shape of the line but can't read actual values without looking at the date chips below.

### Changes in `SessionTrendChart` and `buildPolylinePoints` in `apps/dashboard/app/(app)/analytics/page.tsx`

The SVG uses `viewBox="0 0 100 100"` with `preserveAspectRatio="none"`. Adding text labels inside a `preserveAspectRatio="none"` viewBox distorts them. The fix is to layer a second SVG with normal aspect ratio on top for labels, or to add the labels outside the SVG as absolutely-positioned elements.

The simpler approach: add three Y-axis reference lines and labels outside the chart SVG, using the chart container's relative positioning.

**Step 1:** Change the chart container from `<div className="h-56">` to `<div className="relative h-56">`.

**Step 2:** Inside `SessionTrendChart`, compute three Y reference values: `max`, `Math.round(max / 2)`, and `0`. Render them as absolutely positioned text elements on the left edge of the chart:

```tsx
const yLabels = [
  { value: max, pct: 0 },
  { value: Math.round(max / 2), pct: 50 },
  { value: 0, pct: 100 },
]
```

```tsx
<div className="relative h-56">
  {/* Y-axis labels */}
  <div className="absolute inset-y-0 left-0 flex w-8 flex-col justify-between text-right">
    {yLabels.map(({ value, pct }) => (
      <span
        key={pct}
        className="text-[10px] leading-none text-slate-400"
        style={{ position: 'absolute', top: `${pct}%`, transform: 'translateY(-50%)' }}
      >
        {value}
      </span>
    ))}
  </div>
  {/* Chart SVG — add left margin to avoid overlap with labels */}
  <div className="absolute inset-y-0 left-8 right-0">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
      {/* existing polyline and circles unchanged */}
    </svg>
  </div>
</div>
```

Add horizontal gridlines inside the SVG at y=0, y=50, y=100 as faint lines:

```tsx
<line x1="0" y1="0" x2="100" y2="0" stroke="#e2e8f0" strokeWidth="0.5" />
<line x1="0" y1="50" x2="100" y2="50" stroke="#e2e8f0" strokeWidth="0.5" />
<line x1="0" y1="100" x2="100" y2="100" stroke="#cbd5e1" strokeWidth="1" />
```

No changes to the data fetching, `aggregateSessionSeries`, or `buildPolylinePoints` functions.

---

## Minor Fix — Venue Detail: Tone Display Name

File: `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`

The AI tone card at line 128 renders `{aiConfig.aiTone ?? 'FRIENDLY'}` — the raw enum value. Replace with a display name map:

```ts
const TONE_LABELS: Record<string, string> = {
  FRIENDLY: 'Friendly',
  PROFESSIONAL: 'Professional',
  PLAYFUL: 'Playful',
}
```

```tsx
{
  TONE_LABELS[aiConfig.aiTone ?? 'FRIENDLY'] ?? aiConfig.aiTone ?? 'Friendly'
}
```

Define `TONE_LABELS` as a `const` at the top of the file. One line change in the JSX.

---

## Delivery Notes for Codex

- Phases are ordered by user-facing value. Complete them in order; each is independent.
- Run `turbo run typecheck` and `turbo run lint` after each phase. Do not proceed to the next if either fails.
- Do not add new npm packages.
- Phase 2 Part A is the only change to `packages/api` — adding `place.delete` to `packages/api/src/routers/place.ts`.
- All other changes are in `apps/dashboard/` only.
- Phase 3 converts two pages from client to server components. After this change, those pages must not contain `'use client'` at the top level — the form components they render remain client components and that is correct.
- The Minor Fix can be bundled with whichever phase is done last.
