# Sprint 004 — Guest Chat Polish & Reliability

> Implementation plan for Codex. Each phase is independent and can be assigned separately.
> Read `CLAUDE.md` before writing any code. All tRPC changes belong in `packages/api/src/routers/`.
> Do not introduce new patterns. Do not add dependencies.

---

## Phase 1 — Filter Place Cards to Only Show Referenced Places

**Problem:** `packages/api/src/routers/chat.ts` always returns all 8 semantically-relevant places in the `chat.send` response, regardless of what Claude actually said. A guest asking "do you have free wifi?" gets 8 place cards attached to the answer. A guest asking "where are the restrooms?" sees the closest restroom plus 7 unrelated places. This creates visual noise and makes the chatbot feel broken — the cards don't match the answer.

**Fix:** After Claude responds, filter `relevantPlaces` to only include places whose name appears (case-insensitive) in `assistantResponse`. If no places match, return an empty array — Claude gave a general answer that needed no place reference. Cap the return at 3 places maximum.

### Exact changes in `packages/api/src/routers/chat.ts`

Replace the `return` statement at the end of the `send` procedure (currently lines 328–339) with:

```ts
// Filter places to only those Claude actually mentioned in the response.
// Cap at 3 — more than that in a single turn is visual noise.
const mentionedPlaces = relevantPlaces
  .filter((p) => assistantResponse.toLowerCase().includes(p.name.toLowerCase()))
  .slice(0, 3)

return {
  response: assistantResponse,
  sessionId: session.id,
  places: mentionedPlaces.map((p) => ({
    id: p.id,
    name: p.name,
    photoUrl: p.photoUrl ?? null,
    distanceMeters: p.distanceMeters,
    lat: p.lat,
    lng: p.lng,
  })),
}
```

No other files need to change. The frontend already handles an empty `places` array correctly — it renders nothing.

**Expected result:** Place cards appear only when Claude's response explicitly names a place. Most conversational and general answers return zero cards. Wayfinding answers ("The restrooms are about 40m away in the East Pavilion") return exactly the one or two places named.

---

## Phase 2 — Replace the "..." Loading Indicator on the Send Button

**Problem:** In `apps/web/components/ChatWindow.tsx`, the send button renders `{isLoading ? '...' : 'Send'}`. The literal text `...` during loading looks like a bug, not a deliberate affordance. The button also gives no visual feedback that a message was received and is being processed.

**Fix:** Replace the loading text with a minimal inline SVG spinner. Keep the `'Send'` label in the default state.

### Exact changes in `apps/web/components/ChatWindow.tsx`

Replace the button content (currently line 137):

```tsx
{
  isLoading ? '...' : 'Send'
}
```

with:

```tsx
{
  isLoading ? (
    <svg
      className="h-4 w-4 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  ) : (
    'Send'
  )
}
```

No other changes. The button's `disabled` and `aria` attributes are already correct.

**Expected result:** A spinning indicator replaces the raw `...` text while the assistant is responding.

---

## Phase 3 — Fix Session Over-Mutation on Geolocation Updates

**Problem:** In `apps/web/app/[venueSlug]/chat/page.tsx`, the `ensureSession` `useEffect` lists `lat` and `lng` in its dependency array (line 131). The `useGeolocation` hook uses `watchPosition` with `enableHighAccuracy: true`, which can push position updates every few seconds as the GPS refines its reading. Every update triggers a new `client.chat.session.mutate` call. A guest who stands still for 2 minutes can generate 20+ session mutations — all redundant, all billing API quota.

**Fix:** Track the last coordinates sent to the server in a ref. Skip the mutation if the new position is within 10 meters of the last sent position. Only fire on meaningful movement.

### Exact changes in `apps/web/app/[venueSlug]/chat/page.tsx`

After the existing refs (around line 58), add:

```ts
const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
```

Inside the `ensureSession` async function, before calling `client.chat.session.mutate`, add:

```ts
// Skip if position hasn't moved meaningfully since last sync (within ~10m).
if (lat !== null && lng !== null && lastSyncedPosRef.current !== null) {
  const dLat = Math.abs(lat - lastSyncedPosRef.current.lat)
  const dLng = Math.abs(lng - lastSyncedPosRef.current.lng)
  // ~10m ≈ 0.0001 degrees at mid-latitudes
  if (dLat < 0.0001 && dLng < 0.0001) {
    return
  }
}
```

After the successful mutation (inside `if (!disposed)`), update the ref:

```ts
if (lat !== null && lng !== null) {
  lastSyncedPosRef.current = { lat, lng }
}
```

No API changes needed.

**Expected result:** Session is created once on load and updated only when the guest moves more than ~10 meters. Background mutation noise drops from O(seconds) to O(minutes).

---

## Phase 4 — Show Place Type on PlaceCard and Fix Image Loading

**Problem:** `apps/web/components/PlaceCard.tsx` shows only the place name and distance. A guest who gets directed to "East Pavilion" can't tell from the card whether it's a food outlet, restroom, exhibit, or attraction. The context is lost. Additionally, the `<img>` tag has no `loading` attribute, so all place card images load eagerly — including ones the guest may never scroll to.

**Fix:** Add the place type as a small label below the name. Add `loading="lazy"` to the image.

### Exact changes in `apps/web/components/PlaceCard.tsx`

**Add `type` to the props type** (line 5):

```ts
type PlaceCardProps = {
  id: string
  name: string
  type: string // add this
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
  onCardClick?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onView?: (placeId: string) => void
}
```

**Destructure `type` in the function signature** (line 22):

```ts
export function PlaceCard({
  id,
  name,
  type,              // add this
  photoUrl,
  distanceMeters,
  lat,
  lng,
  onCardClick,
  onDirectionsClick,
  onView,
}: PlaceCardProps) {
```

**Add type label** in the text block (currently lines 57–60). Replace the `<div className="min-w-0 flex-1 py-2 pr-3">` block with:

```tsx
<div className="min-w-0 flex-1 py-2 pr-3">
  <p className="truncate text-sm font-semibold text-white">{name}</p>
  <p className="text-xs text-slate-400 capitalize">{type.toLowerCase().replace(/_/g, ' ')}</p>
  <p className="text-xs text-cyan-300">{formatDistance(distanceMeters)}</p>
</div>
```

**Add `loading="lazy"` to the `<img>`** (currently line 48):

```tsx
<img src={photoUrl} alt={name} loading="lazy" className="h-16 w-16 shrink-0 object-cover" />
```

**Update `ChatWindow.tsx` to pass `type` to `PlaceCard`:**

The `PlaceSummary` type in `ChatWindow.tsx` (line 9–16) needs a `type` field:

```ts
type PlaceSummary = {
  id: string
  name: string
  type: string // add this
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
}
```

Pass it through the `PlaceCard` render in the messages map (currently line 82–95):

```tsx
<PlaceCard
  key={place.id}
  id={place.id}
  name={place.name}
  type={place.type} // add this
  photoUrl={place.photoUrl}
  distanceMeters={place.distanceMeters}
  lat={place.lat}
  lng={place.lng}
  {...(onPlaceCardClick ? { onCardClick: onPlaceCardClick } : {})}
  {...(onPlaceCardView ? { onView: onPlaceCardView } : {})}
  {...(onDirectionsClick ? { onDirectionsClick } : {})}
/>
```

**Update `chat/page.tsx`** — the `PlaceSummary` type (line 24–30) also needs `type`:

```ts
type PlaceSummary = {
  id: string
  name: string
  type: string // add this
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
}
```

**Update `packages/api/src/routers/chat.ts`** — the `return` statement built in Phase 1 maps places. Ensure `type` is included:

```ts
places: mentionedPlaces.map((p) => ({
  id: p.id,
  name: p.name,
  type: p.type,          // add this
  photoUrl: p.photoUrl ?? null,
  distanceMeters: p.distanceMeters,
  lat: p.lat,
  lng: p.lng,
})),
```

The `type` field is already present on the `relevantPlaces` objects (both the embedding search result and the geo fallback `allPlaces` query already select `type`). No database or schema changes needed.

**Expected result:** Each place card shows name, type (formatted as "food outlet", "restroom", "exhibit"), and distance. Images load lazily.

---

## Phase 5 — Fix the LocationBanner "Loading" State

**Problem:** `apps/web/components/LocationBanner.tsx` shows a "Retry" button when `permission === 'loading'`. This is confusing — you can't retry a check that's still in progress. Pressing "Retry" during the loading state calls `startWatch()` again, creating a second `watchPosition` subscription before the first has resolved.

Additionally, the "loading" description text says "PathFinder is preparing live wayfinding for this venue." — this is vague marketing copy that doesn't tell the guest what's actually happening.

**Fix:** Remove the action button from the loading state. Update the copy to be direct.

### Exact changes in `apps/web/components/LocationBanner.tsx`

Replace the `content` object construction (currently lines 12–28) with:

```ts
if (permission === 'loading') {
  return (
    <section className="mb-4 rounded-[1.75rem] border border-slate-600/30 bg-slate-800/40 p-4 text-slate-300 shadow-lg">
      <p className="text-sm font-semibold">Checking location…</p>
      <p className="mt-1 text-sm leading-6 text-slate-400">
        Waiting for your device to share its position.
      </p>
    </section>
  )
}

const content =
  permission === 'denied'
    ? {
        title: 'Location access denied',
        description: 'Enable location in your browser settings to get distance-aware answers.',
        action: 'Try again',
      }
    : {
        title: 'Allow location for better answers',
        description: 'PathFinder uses your position to tell you what is nearby.',
        action: 'Share location',
      }
```

Remove the `permission === 'loading'` branch from the original ternary. The `return null` for `'granted'` stays at line 8 as-is.

**Expected result:** The loading state shows a quiet non-interactive message. The denied and prompt states retain their action button. No double-subscription risk.

---

## Phase 6 — Back Navigation and Greeting Copy on the Chat Page

**Problem:** Two issues on `apps/web/app/[venueSlug]/chat/page.tsx`:

1. **No back navigation.** Guests who arrive at the chat page via the venue landing page have no way back to the landing page except the browser back button. The header has no link. On an embedded kiosk or PWA with no browser chrome, the guest is stuck.

2. **The greeting copy is generic.** The intro section (lines 300–306) says: "Hi! I'm your [Name] guide. Ask me anything about the venue — I'll point you in the right direction." The phrase "I'm your guide" is AI-generated boilerplate. It also breaks the product voice — the experience should feel like a venue tool, not a chatbot persona.

**Fix:**

**Part A — Add back link to the header.**

In the `<header>` block (lines 286–294), add a back link before the category eyebrow:

```tsx
<header className="mb-4 rounded-[2rem] border border-white/10 bg-slate-900/65 p-5 shadow-2xl shadow-cyan-950/30 backdrop-blur">
  <Link
    href={`/${venueSlug}`}
    className="mb-3 inline-flex items-center gap-1.5 text-xs text-slate-400 transition hover:text-slate-200"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-3 w-3"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
    Back
  </Link>
  <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">
    {venue.category ?? 'Venue assistant'}
  </p>
  <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{venue.name}</h1>
  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
    {venue.description ?? 'Ask where things are, what to do next, or what is nearby.'}
  </p>
</header>
```

**Part B — Replace the greeting section copy.**

Replace the `<section>` block shown when `messages.length === 0` (lines 300–307):

```tsx
<section className="mb-4 rounded-[2rem] border border-white/10 bg-slate-900/65 p-5 shadow-xl backdrop-blur">
  <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
    What can I help you find?
  </h2>
  <p className="mt-2 text-sm leading-6 text-slate-300">
    Ask about exhibits, food, restrooms, directions, or anything else at the venue.
  </p>
</section>
```

This removes the chatbot-persona framing ("Hi! I'm your guide") and replaces it with a direct, action-oriented prompt that matches how guests actually think when they're standing somewhere trying to find something.

`Link` is already imported in this file (line 4).

**Expected result:** Guests have a clear escape route back to the venue landing page. The greeting no longer sounds like a chatbot persona introduction.

---

## Phase 7 — Quick Prompt Copy and Chip Layout Polish

**Problem:** `apps/web/components/QuickPromptChips.tsx` has two issues:

1. **"What makes [Venue Name] special?"** is grammatically clunky and doesn't fit a wayfinding context. Guests are standing inside the venue — they know it's special, they want to know where to go.

2. **The grid layout forces chips to two columns on mobile.** `grid grid-cols-2 gap-3` means all six chips are split into two fixed columns. Short prompts like "Where's the bathroom?" and long ones like "What animals can I see today?" get the same fixed-width cell. `flex flex-wrap` on all screen sizes would let chips size naturally.

**Fix:**

### Exact changes in `apps/web/components/QuickPromptChips.tsx`

**Update `buildPrompts`** — replace the venue-name prompt (line 15):

```ts
venueName ? `Tell me about ${venueName}` : "What's this venue all about?",
```

**Fix the chip container layout** (line 32) — replace `grid grid-cols-2 gap-3 sm:flex sm:flex-wrap` with:

```tsx
<div className="flex flex-wrap gap-2">
```

Reduce the button padding slightly to `px-3` (from `px-4`) and the min-height to `min-h-10` (from `min-h-11`) so chips fit naturally in the flex wrap layout on small screens. Remove the `sm:justify-start sm:text-left` overrides since all chips are now flex items:

```tsx
<button
  key={prompt}
  className="inline-flex min-h-10 items-center justify-center rounded-full border border-white/10 bg-white/5 px-3 text-center text-sm font-medium text-slate-100 transition hover:border-cyan-400/40 hover:bg-cyan-400/10"
  type="button"
  onClick={() => {
    onSend(prompt)
  }}
>
  {prompt}
</button>
```

No logic changes — only copy and layout.

**Expected result:** Chips wrap naturally on all screen sizes. The venue-name prompt is conversational rather than awkward.

---

## Delivery Notes for Codex

- Phases 1–7 are ordered by user impact. Complete them in order.
- Phase 1 is the most important — it changes what the API returns and affects every subsequent phase that reads `places`.
- Phase 4 depends on Phase 1 completing first (both touch the `places` return shape in `chat.ts`). Merge Phase 1 and 4 into a single pass on `chat.ts` to avoid a conflict.
- Run `turbo run typecheck` and `turbo run lint` after each phase. Do not proceed if either fails.
- Do not add new npm packages.
- Do not modify `packages/db`, `packages/auth`, or any worker code.
- Files changed across all phases:
  - `packages/api/src/routers/chat.ts` (Phase 1 + 4)
  - `apps/web/components/ChatWindow.tsx` (Phase 2 + 4)
  - `apps/web/app/[venueSlug]/chat/page.tsx` (Phase 3 + 4 + 6)
  - `apps/web/components/PlaceCard.tsx` (Phase 4)
  - `apps/web/components/LocationBanner.tsx` (Phase 5)
  - `apps/web/components/QuickPromptChips.tsx` (Phase 7)
