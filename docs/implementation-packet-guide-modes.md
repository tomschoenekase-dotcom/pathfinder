# IMPLEMENTATION PACKET: PathFinder Guide Modes + Non-Location Support

**Prepared for:** Codex  
**Date:** 2026-05-02  
**Branch target:** feature/guide-modes  
**Status:** Ready for step-by-step execution

---

## IMPORTANT: Two-Pass Execution Strategy

**This packet is divided into Pass 1 and Pass 2. Execute Pass 1 completely and verify it before starting Pass 2.**

**Pass 1** (Tasks 1–10) is safe and low-risk. It adds `guideMode` to venues, makes chat behavior conditional, fixes the critical runtime bug that would crash non-location chat, and delivers a working non-location venue experience. No TypeScript type cascade. No lat/lng schema changes.

**Pass 2** (Tasks 11–16) makes coordinates truly optional in the database, Zod schemas, and admin form, and relabels "Places" to "Guide Items" in the UI. This introduces a TypeScript type cascade because `place.lat` and `place.lng` go from `number` to `number | null`. TypeScript will emit compile errors in any file that passes these values to functions expecting a non-null number. These errors are recoverable and caught by `turbo run typecheck` before deployment — but they require careful review. Do not start Pass 2 until Pass 1 is verified working and deployed.

---

## A. Current Architecture Summary

This summary is derived from direct codebase inspection. All file paths are confirmed real.

### Venues

- **Model:** `Venue` in `packages/db/prisma/schema.prisma` (lines ~125–159)
- **Fields relevant to this task:**
  - `defaultCenterLat` (Float, optional) — fallback center for chat
  - `defaultCenterLng` (Float, optional) — fallback center for chat
  - `category` (String, optional) — e.g. "AQUARIUM", "ZOO"
  - No existing `guideMode` field
- **Form UI:** `apps/dashboard/components/VenueForm.tsx`
  - Has `name`, `slug`, `description`, `guideNotes`, `category`, `defaultCenterLat`, `defaultCenterLng`
  - Coordinates are plain optional number inputs with no conditional logic
- **Zod schema:** `packages/api/src/schemas/venue.ts`
  - `CreateVenueInput`, `UpdateVenueInput` — coordinates are `number.optional()`
- **tRPC router:** `packages/api/src/routers/venue.ts`
  - Procedures: `create`, `update`, `updateAiConfig`, `updateChatDesign`, `delete`, `getById`, `getBySlug`, `list`

### Places

- **Model:** `Place` in `packages/db/prisma/schema.prisma` (lines ~161–187)
- **Fields relevant to this task:**
  - `lat` (Float, **required** — no `?`)
  - `lng` (Float, **required** — no `?`)
  - `type` (String, required) — free text, no enum enforcement
  - `name`, `shortDescription`, `longDescription`, `tags`, `importanceScore`, `areaName`, `hours`, `photoUrl`
  - No existing `itemType` field
- **Form UI:** `apps/dashboard/components/PlaceForm.tsx`
  - `lat` and `lng` are required fields in the form
  - `type` is a free-text field with datalist suggestions: `attraction, amenity, restroom, food, seating, exhibit, scenic_spot, entrance`
  - Advanced section (collapsible): longDescription, tags, importanceScore, areaName, hours, photoUrl
- **Zod schema:** `packages/api/src/schemas/place.ts`
  - `CreatePlaceInput` — `lat: number` and `lng: number` are **required** (no `.optional()`)
  - This is the primary validation gate
- **tRPC router:** `packages/api/src/routers/place.ts`
  - Procedures: `create`, `update`, `delete`, `list`, `getById`, `bulkCreate`
  - `create` auto-triggers embedding generation

### Coordinates

- **At the DB level:** `Place.lat` and `Place.lng` are `Float` (required, no `?`)
- **At the Zod level:** `lat: number` and `lng: number` with no `.optional()`
- **At the form level:** Both are required inputs
- **In RAG fallback:** `geo.ts` `findNearestPlaces` calculates Haversine distance for all active places — if `lat`/`lng` are null/undefined this will produce NaN
- **In system prompt:** `venue-context.ts` `formatDistance` is called with `userLat`, `userLng`, `place.lat`, `place.lng` — safe if distances are omitted from prompt context

### Chat Behavior

- **Visitor chat page:** `apps/web/app/[venueSlug]/chat/page.tsx`
- **System prompt assembly:** `packages/api/src/lib/venue-context.ts` — `buildVenueSystemPrompt()`
- **Chat router:** `packages/api/src/routers/chat.ts` — `send` procedure
- **Quick prompts:** `apps/web/components/QuickPromptChips.tsx` — static array, only varies on `venueCategory === 'ZOO' || 'AQUARIUM'`
- **Location banner:** `apps/web/components/LocationBanner.tsx` — shown on all venues regardless of type
- **Geolocation hook:** `apps/web/hooks/useGeolocation.ts` — always runs, always prompts for permission
- **Location fallback:** If no user location and no `defaultCenterLat/Lng`, chat.send returns a hard error — **this would permanently break all non-location venues without the fix in Task 6**

### Database Migration Files

- **Location:** `packages/db/prisma/migrations/`
- **Naming convention:** `001_identity_foundation`, `002_platform_controls`, etc. (numbered + named)

### Seed Data

- **File:** `packages/db/prisma/seed.ts`
- **Current demo:** Riverside Aquarium with 13 places, all with coordinates

---

## B. Recommended Implementation Strategy

### Pass 1: Add guideMode, fix chat, deliver non-location experience

The core insight is that a non-location venue can work today — the AI doesn't actually need coordinates to answer from guide item content. The embedding/semantic search pipeline is entirely text-based. The only things blocking non-location venues right now are:

1. A hard runtime error in `chat.ts` that throws when location is unavailable
2. A location-biased system prompt that adds distance text to every place
3. A location banner that always asks for GPS permission
4. Quick prompts that assume the visitor is navigating physically

All four of these can be fixed without touching the `Place` schema at all. Pass 1 delivers a fully working non-location venue by fixing these things and adding `guideMode` to `Venue`. Places still require coordinates in Pass 1 — the admin experience for non-location venues is slightly awkward (operators must enter `0` or a placeholder for lat/lng), but the visitor chat experience is correct and functional.

**Pass 1 database change:** Add only `guideMode String @default("location_aware")` to `Venue`. One column, safe default, no type cascade.

### Pass 2: Make coordinates optional end-to-end

Pass 2 removes the lat/lng requirement from the `Place` schema, Zod validation, and admin form. This is the right final state, but it causes a TypeScript type cascade: `place.lat` and `place.lng` become `number | null` everywhere in the codebase. Any file that passes these to a function expecting a non-null `number` will produce a TypeScript compile error. These errors are caught before deployment by `turbo run typecheck`, so nothing breaks in production — but Codex must work through each one carefully.

Pass 2 also adds `itemType` to `Place` and relabels "Places" as "Guide Items" in the dashboard UI.

**Only start Pass 2 after Pass 1 is deployed and confirmed working.**

### Preserve the `Place` model and table name

Do not rename `Place` to `GuideItem` in the database. The model is well-established, has relations, embeddings, analytics events, and RAG logic depending on it. A rename would require touching 10+ files and carries migration risk.

**Instead:** Update UI labels to say "Guide Items" where shown to venue operators (Pass 2). The backend remains `Place`. This is safe and reversible.

### Existing venues: zero-touch migration

The `guideMode` field defaults to `'location_aware'` at the DB level. No data migration script is needed. Existing venues continue working exactly as they do today.

---

## C. Data Model Changes

### Pass 1 — Venue Model Addition Only

```prisma
// Add to Venue model in packages/db/prisma/schema.prisma
guideMode  String  @default("location_aware")  // "location_aware" | "non_location"
```

No enum in Prisma — use a plain `String` with a default. This avoids enum migration complexity and keeps the field flexible for future modes.

**Pass 1 migration SQL:**

```sql
ALTER TABLE "Venue" ADD COLUMN "guideMode" TEXT NOT NULL DEFAULT 'location_aware';
```

That is the only SQL in the Pass 1 migration.

---

### Pass 2 — Place Model Changes

```prisma
// In Place model in packages/db/prisma/schema.prisma
// Change from:
lat  Float
lng  Float
// Change to:
lat  Float?
lng  Float?

// Add new field:
itemType  String?  // "physical_place" | "exhibit" | "room" | "sculpture" | "service_step" | "faq" | "amenity" | "policy" | "activity" | "general_info"
```

**Pass 2 migration SQL:**

```sql
ALTER TABLE "Place" ALTER COLUMN "lat" DROP NOT NULL;
ALTER TABLE "Place" ALTER COLUMN "lng" DROP NOT NULL;
ALTER TABLE "Place" ADD COLUMN "itemType" TEXT;
```

Existing rows retain their coordinate values. `itemType` defaults to `NULL` for all existing rows. No data loss.

---

### Zod Schema Changes

**Pass 1 — `packages/api/src/schemas/venue.ts`:**

```typescript
// Add to CreateVenueInput and UpdateVenueInput:
guideMode: z.enum(['location_aware', 'non_location']).default('location_aware').optional(),
```

**Pass 2 — `packages/api/src/schemas/place.ts`:**

```typescript
// Change in CreatePlaceInput:
lat: z.number().optional(),
lng: z.number().optional(),

// Add to CreatePlaceInput and UpdatePlaceInput:
itemType: z.enum([
  'physical_place', 'exhibit', 'room', 'sculpture',
  'service_step', 'faq', 'amenity', 'policy', 'activity', 'general_info'
]).optional(),
```

---

## D. Admin UI Changes

### Pass 1 — VenueForm Guide Mode Selector

**File:** `apps/dashboard/components/VenueForm.tsx`

**Where to insert:** After the `category` field, before the `defaultCenterLat`/`defaultCenterLng` fields.

**UI treatment:** A simple radio group or toggle with two options:

```
Use location features?

◉ Yes — This venue uses physical places with coordinates.
  (Parks, sculpture parks, nature centers, campuses, large attractions)

○ No — This venue is an exhibit, service, or informational guide.
  (Historic sites, small museums, food pantries, service organizations)
```

Store the selected value as `guideMode: 'location_aware' | 'non_location'`.

For existing venues in edit mode, display the current value (default: `location_aware`).

Hide `defaultCenterLat` and `defaultCenterLng` when `guideMode === 'non_location'` — they are unused for non-location venues.

**Note for Pass 1:** The place creation form still requires lat/lng in Pass 1. Operators creating guide items for non-location venues should enter `0` as a placeholder. This is a known limitation that Pass 2 fixes.

### Pass 2 — PlaceForm Coordinate Optionality

**File:** `apps/dashboard/components/PlaceForm.tsx`

Add a `venueGuideMode: 'location_aware' | 'non_location'` prop to `PlaceForm`.

For `lat` and `lng` fields:

- When `venueGuideMode === 'location_aware'`: show as today — required, prominent
- When `venueGuideMode === 'non_location'`: move to the advanced/collapsible section, mark as optional, add helper text: "Optional — only needed if this item has a physical location."

### Pass 2 — PlaceForm Item Type Field

Add an `itemType` field after `name`. Use a `<select>` element (not free text):

```
Item type (optional)

[dropdown]
— (no selection) —
Physical place
Exhibit
Room
Sculpture
Service step
FAQ
Amenity
Policy
Activity
General info
```

For `location_aware` venues: optional, in the advanced section.
For `non_location` venues: prominent, just after the name field.

### Pass 2 — UI Label Changes

Change user-facing labels from "Places" to "Guide Items" in `apps/dashboard/` only:

- Button labels: "Add Place" → "Add Guide Item", "New Place" → "New Guide Item"
- Page titles and headings in venue/place routes
- Breadcrumbs, nav links, empty state text

**Do NOT rename:** route paths (`/places/`), API procedure names, Prisma model name, router file names, Zod schema names. Internal only.

---

## E. Visitor Chat Changes

### 1. Location Banner — Hide for Non-Location Venues

**File:** `apps/web/components/LocationBanner.tsx`  
**File:** `apps/web/app/[venueSlug]/chat/page.tsx`

Add a `show?: boolean` prop to `LocationBanner`. Return `null` if `show === false`.

In the chat page: `<LocationBanner show={venue.guideMode !== 'non_location'} />`

### 2. Quick Prompts — Differ by Guide Mode

**File:** `apps/web/components/QuickPromptChips.tsx`

Update `buildPrompts` to accept `guideMode`:

```typescript
// For guideMode === 'non_location' (new):
'What should I know first?'
'Explain this place to me.'
'Walk me through what to do when I arrive.'
'What is the most important thing to know here?'`Tell me about ${venueName}.`
;('Can you explain something in simpler terms?')

// For guideMode === 'location_aware' (existing, unchanged):
;("What's worth seeing near me right now?")
;('Where should I go next?')
;('Where are the restrooms?')
"What's good to eat or drink here?"`What makes ${venueName} special?`
;("What's good to do with kids?") // or animal variant for ZOO/AQUARIUM
```

### 3. System Prompt — Adapt for Guide Mode

**File:** `packages/api/src/lib/venue-context.ts` — `buildVenueSystemPrompt()`

Add a `guideMode?: string` parameter (default `'location_aware'`).

**For `non_location` venues:**

Change role description from "a helpful on-site guide" to "a knowledgeable guide."

Replace distance/navigation rules with content-focused rules:

```
"Focus on explaining and interpreting the content at this venue."
"Help the visitor understand exhibits, history, services, or processes."
"Do not emphasize distances, nearby items, or navigation unless asked."
"If asked about navigation or location, explain this is a content guide, not a map."
```

Guard the distance calculation for each place in the context block:

```typescript
const distancePart =
  guideMode !== 'non_location' &&
  place.lat != null &&
  place.lng != null &&
  userLat != null &&
  userLng != null
    ? `, ${formatDistance(userLat, userLng, place.lat, place.lng)}`
    : ''
```

### 4. Chat Router — Guard Geo Logic (CRITICAL — do not skip)

**File:** `packages/api/src/routers/chat.ts` — `send` procedure

This is the highest-priority fix in the entire packet. Without it, no non-location venue can ever send a chat message.

After loading the venue: `const guideMode = venue.guideMode ?? 'location_aware'`

**Guard 1 — location unavailable error:** Currently throws `BAD_REQUEST` if both `userLat` and `venue.defaultCenterLat` are null. This always fires for non-location venues. Wrap it:

```typescript
if (guideMode === 'location_aware' && userLat == null && venue.defaultCenterLat == null) {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Location is still unavailable for this venue.',
  })
}
```

**Guard 2 — geo-distance fallback:** Currently always calls `findNearestPlaces` when semantic search fails. For non-location venues with no user location, this call either crashes or returns nothing useful. Replace:

```typescript
const fallbackPlaces =
  guideMode === 'location_aware' && userLat != null
    ? await findNearestPlaces(db, venueId, tenantId, userLat, userLng, 8)
    : await db.place.findMany({
        where: { venueId, tenantId, isActive: true },
        orderBy: { importanceScore: 'desc' },
        take: 8,
      })
```

Pass `guideMode` to `buildVenueSystemPrompt()`.

### 5. Visitor Chat Page — Thread Guide Mode to Components

**File:** `apps/web/app/[venueSlug]/chat/page.tsx`

Ensure the venue query returns `guideMode`. Thread it to:

- `<LocationBanner show={venue.guideMode !== 'non_location'} />`
- `<QuickPromptChips venueName={venue.name} venueCategory={venue.category} guideMode={venue.guideMode} />`

---

## F. Backend / API Changes

### Pass 1

**`packages/api/src/routers/venue.ts`:**

- `create`: include `guideMode: input.guideMode ?? 'location_aware'` in `db.venue.create`
- `update`: include `guideMode: input.guideMode` if provided
- `getBySlug`, `getById`, `list`: add `guideMode` to `select` clause

**`packages/api/src/routers/chat.ts`:**

- Read `venue.guideMode` after venue load
- Apply both guards described in section E.4
- Pass `guideMode` to `buildVenueSystemPrompt()`

**`packages/api/src/lib/venue-context.ts`:**

- Add `guideMode?` param to `buildVenueSystemPrompt()` — default `'location_aware'`
- Apply content-focused rules and distance guard (section E.3)

### Pass 2

**`packages/api/src/routers/place.ts`:**

- `create`, `update`: include `itemType: input.itemType`
- `list`, `getById`: add `itemType` to `select` clause

**`packages/api/src/lib/geo.ts` — `findNearestPlaces`:**

- Filter out places where `lat == null || lng == null` before Haversine calculation (defensive guard even though the router guard in Task 6 prevents this path for non-location venues)

---

## G. Step-by-Step Codex Task List

---

# PASS 1

**Stop condition:** After Task 10, run the Pass 1 acceptance criteria. Do not proceed to Pass 2 until all Pass 1 criteria pass.

---

### Task 1 — Add `guideMode` to Venue Prisma schema

**Goal:** Add the `guideMode` field to the Venue model.

**File:** `packages/db/prisma/schema.prisma`

**Change:** In the `Venue` model, add after the `category` field:

```prisma
guideMode  String  @default("location_aware")
```

**Warning:** Do not use a Prisma `enum`. Use plain `String` with a default.

**Verification:** Run `pnpm --filter @pathfinder/db db:validate` (or `prisma validate`). No errors.

---

### Task 2 — Generate and apply the Pass 1 migration

**Goal:** Add `guideMode` to the Venue table in the database.

**Run from:** `packages/db`

**Command:**

```bash
pnpm db:migrate --name add_venue_guide_mode
```

**Expected SQL in the generated migration file:**

```sql
ALTER TABLE "Venue" ADD COLUMN "guideMode" TEXT NOT NULL DEFAULT 'location_aware';
```

**Warning:** Only this one SQL statement should be in the Pass 1 migration. Do not combine with lat/lng changes — those belong to Pass 2. Do not edit an existing migration file.

**Verification:** Confirm the migration file exists at `packages/db/prisma/migrations/XXX_add_venue_guide_mode/migration.sql`. Apply to dev DB and confirm no errors. Confirm all existing venues now have `guideMode = 'location_aware'`.

---

### Task 3 — Update Venue Zod schema

**Goal:** Allow `guideMode` to pass through API validation.

**File:** `packages/api/src/schemas/venue.ts`

**Changes:**

In `CreateVenueInput`, add:

```typescript
guideMode: z.enum(['location_aware', 'non_location']).default('location_aware').optional(),
```

In `UpdateVenueInput`, add:

```typescript
guideMode: z.enum(['location_aware', 'non_location']).optional(),
```

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No type errors.

---

### Task 4 — Update Venue tRPC router

**Goal:** Persist and return `guideMode` through venue procedures.

**File:** `packages/api/src/routers/venue.ts`

**Changes:**

1. In the `create` procedure's `db.venue.create` call, add: `guideMode: input.guideMode ?? 'location_aware'`
2. In the `update` procedure's `db.venue.update` call, add: `guideMode: input.guideMode` (only if provided)
3. In `getBySlug`, `getById`, and `list` procedures, add `guideMode` to the `select` clause

**Warning:** If any of these procedures use a `select` object to whitelist returned fields, `guideMode` must be explicitly added to each one. If they return the full model, the new field will be included automatically.

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No type errors. Manually confirm that creating a venue with `guideMode: 'non_location'` and then fetching it returns the correct value.

---

### Task 5 — Guard distance logic in `venue-context.ts`

**Goal:** Prevent NaN distances and location-centric prompt text for non-location venues.

**File:** `packages/api/src/lib/venue-context.ts`

**Changes:**

1. Add `guideMode?: string` as the last parameter of `buildVenueSystemPrompt`. Default it to `'location_aware'` if not provided (preserves all existing callers with no change).

2. Find the section where each place's context block is built. Guard the distance calculation:

```typescript
const distancePart =
  guideMode !== 'non_location' &&
  place.lat != null &&
  place.lng != null &&
  userLat != null &&
  userLng != null
    ? `, ${formatDistance(userLat, userLng, place.lat, place.lng)}`
    : ''
```

3. Find the rules section of the system prompt. Make it conditional:

```typescript
const behaviorRules =
  guideMode === 'non_location'
    ? [
        'Focus on explaining and interpreting the content at this venue.',
        'Help the visitor understand exhibits, history, services, or processes.',
        'Do not emphasize distances, nearby items, or navigation unless asked.',
        'If asked about navigation or location, explain this is a content guide, not a map.',
      ]
    : [
        'Lead with experience — distance is secondary.',
        'Use natural distance phrasing: "right nearby", "about 200 feet away", "a short walk".',
      ]
```

**Warning:** Do not remove or change the existing distance rules from the `location_aware` branch. Existing venues depend on them.

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No errors.

---

### Task 6 — Guard geo fallback and location error in chat router

**Goal:** Fix the critical runtime bug that would permanently block non-location venue chat.

**File:** `packages/api/src/routers/chat.ts` — `send` procedure

**This is the most important task in Pass 1. Without it, any non-location venue will return a hard error on every chat message.**

**Changes:**

1. After the venue is loaded, add: `const guideMode = venue.guideMode ?? 'location_aware'`

2. Find the location-unavailable error (search for the string `'Location is still unavailable'` or similar). Wrap it in a guide mode guard:

```typescript
if (guideMode === 'location_aware' && userLat == null && venue.defaultCenterLat == null) {
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Location is still unavailable for this venue.',
  })
}
```

3. Find the geo-distance fallback (the call to `findNearestPlaces`). Replace it with a conditional:

```typescript
const fallbackPlaces =
  guideMode === 'location_aware' && userLat != null
    ? await findNearestPlaces(db, venueId, tenantId, userLat, userLng, 8)
    : await db.place.findMany({
        where: { venueId, tenantId, isActive: true },
        orderBy: { importanceScore: 'desc' },
        take: 8,
      })
```

4. Pass `guideMode` to `buildVenueSystemPrompt()` as the new last argument.

**Warning:** The variable names for user lat/lng in the `send` input may be `lat` and `lng` (not `userLat`/`userLng`). Read the actual procedure carefully to get the correct variable names before editing.

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No errors. Manually test: call `chat.send` with a non-location venue (guideMode set to `'non_location'`) and no lat/lng in the request. Confirm a valid AI response is returned, not an error.

---

### Task 7 — Update `VenueForm` to add guide mode selector

**Goal:** Allow venue operators to set guide mode when creating or editing a venue.

**File:** `apps/dashboard/components/VenueForm.tsx`

**Changes:**

1. Add `guideMode` to the form default values: `guideMode: venue?.guideMode ?? 'location_aware'`

2. Register `guideMode` with the existing form library (react-hook-form pattern — match what is already in the file)

3. Add a guide mode selector UI component after the `category` field:

```
Label: "Guide type"
Helper text: "Choose how this venue's assistant should behave."

Radio options:
  value="location_aware"
    Label: "Location-aware guide"
    Description: "For parks, sculpture parks, nature centers, campuses, and attractions. Uses coordinates and distance."
  value="non_location"
    Label: "Non-location guide"
    Description: "For historic sites, museums, galleries, food pantries, and service organizations. No coordinates required."
```

4. Hide `defaultCenterLat` and `defaultCenterLng` when guide mode is `non_location`:

```typescript
const watchGuideMode = watch('guideMode') // react-hook-form watch
// Wrap the lat/lng field group in: {watchGuideMode !== 'non_location' && (...)}
```

5. Add `guideMode` to the form submit payload passed to the tRPC mutation.

**Warning:** Match the existing form library pattern exactly. Do not introduce a new form library.

**Note:** In Pass 1, the place form still requires lat/lng. This is a known limitation. Add a visible note in the admin UI for non-location venues under the guide items section: "In non-location mode, enter 0 for lat/lng if you don't have coordinates. Coordinate fields will be made optional in an upcoming update."

**Verification:** Create a venue with `non_location`. Confirm `guideMode` is stored correctly. Verify lat/lng fields are hidden on the venue form. Verify existing venue edit shows `location_aware` by default.

---

### Task 8 — Update `QuickPromptChips` for non-location venues

**Goal:** Show content-focused quick prompts for non-location venues.

**File:** `apps/web/components/QuickPromptChips.tsx`

**Changes:**

1. Add `guideMode?: string` to the component props.

2. Update the prompt-building logic to branch on `guideMode`:

```typescript
if (guideMode === 'non_location') {
  return [
    'What should I know first?',
    'Explain this place to me.',
    'Walk me through what to do when I arrive.',
    'What is the most important thing to know here?',
    venueName ? `Tell me about ${venueName}.` : 'What is this place all about?',
    'Can you explain something in simpler terms?',
  ]
}
// Default (location_aware) — existing prompts unchanged
return [
  "What's worth seeing near me right now?",
  'Where should I go next?',
  'Where are the restrooms?',
  "What's good to eat or drink here?",
  venueName ? `What makes ${venueName} special?` : "What's this venue all about?",
  venueCategory === 'ZOO' || venueCategory === 'AQUARIUM'
    ? 'What animals can I see today?'
    : "What's good to do with kids?",
]
```

3. In the parent chat page, pass `guideMode={venue.guideMode}` to `<QuickPromptChips>`.

**Verification:** Open chat for a non-location venue. Confirm content-focused prompts appear. Open chat for an existing location-aware venue. Confirm existing prompts are unchanged.

---

### Task 9 — Hide `LocationBanner` for non-location venues

**Goal:** Do not prompt visitors for GPS permission when the venue doesn't use coordinates.

**Files:**

- `apps/web/components/LocationBanner.tsx`
- `apps/web/app/[venueSlug]/chat/page.tsx`

**Changes:**

1. In `LocationBanner.tsx`, add a `show?: boolean` prop. Add at the top of the render: `if (show === false) return null;`

2. In the chat page, pass `show={venue.guideMode !== 'non_location'}` to `<LocationBanner>`.

**Warning:** The `useGeolocation` hook can continue to run silently — just don't render the visible banner for non-location venues.

**Verification:** Load chat for a non-location venue. Confirm no location banner appears and no browser location permission dialog is triggered. Load chat for a location-aware venue — confirm banner still appears as before.

---

### Task 10 — Add non-location demo seed data

**Goal:** Provide a testable non-location demo venue in development.

**File:** `packages/db/prisma/seed.ts`

**Changes:** Add a second demo venue and guide items after the existing Riverside Aquarium block. In Pass 1, places must include placeholder coordinates (`lat: 0, lng: 0`) because the schema still requires them.

```typescript
// Demo Venue 2: Historic Sappington House (non-location)
const demoVenueHistoric = await db.venue.upsert({
  where: { id: 'demo-venue-sappington-house' },
  update: {},
  create: {
    id: 'demo-venue-sappington-house',
    tenantId: 'demo-tenant',
    name: 'Historic Sappington House',
    slug: 'sappington-house',
    category: 'MUSEUM',
    description: 'A historic 19th-century home offering guided and self-guided tours.',
    guideMode: 'non_location',
    aiTone: 'FRIENDLY',
    aiGuideName: 'Clara',
    guideNotes:
      'A single-story historic house with rooms organized roughly front to back from public to private.',
    aiGuideNotes:
      'Focus on the Sappington family history and 1800s daily life. Always mention the kitchen hearth as a highlight.',
  },
})

const sappingtonItems = [
  {
    id: 'demo-sappington-overview',
    name: 'Overview of the House',
    type: 'general_info',
    shortDescription: 'Introduction to the house, its history, and what visitors will experience.',
  },
  {
    id: 'demo-sappington-family',
    name: 'Sappington Family History',
    type: 'exhibit',
    shortDescription: 'The story of the Sappington family who built and lived in this home.',
  },
  {
    id: 'demo-sappington-kitchen',
    name: 'The Kitchen',
    type: 'room',
    shortDescription: 'The working kitchen featuring a large hearth used for all cooking.',
  },
  {
    id: 'demo-sappington-parlor',
    name: 'The Parlor',
    type: 'room',
    shortDescription: 'The formal parlor where guests were received.',
  },
  {
    id: 'demo-sappington-daily-life',
    name: 'Time Period and Daily Life',
    type: 'exhibit',
    shortDescription: 'What life was like in this household in the 1800s.',
  },
  {
    id: 'demo-sappington-visitor-info',
    name: 'Tours and Visitor Info',
    type: 'faq',
    shortDescription: 'Tour schedules, admission, accessibility, and visitor policies.',
  },
]

for (const item of sappingtonItems) {
  await db.place.upsert({
    where: { id: item.id },
    update: {},
    create: {
      ...item,
      tenantId: 'demo-tenant',
      venueId: demoVenueHistoric.id,
      lat: 0, // placeholder — Pass 2 will make coordinates optional
      lng: 0, // placeholder — Pass 2 will make coordinates optional
      importanceScore: 5,
      isActive: true,
    },
  })
}
```

**Warning:** Do not remove or modify the existing Riverside Aquarium seed data.

**Verification:** Run `pnpm --filter @pathfinder/db db:seed`. Confirm both venues exist. Confirm Riverside Aquarium data is unchanged.

---

### Pass 1 Acceptance Criteria — Verify Before Proceeding to Pass 2

Run these checks after Task 10. Do not start Pass 2 until all pass.

- [ ] `turbo run typecheck` — zero errors
- [ ] `turbo run lint` — zero errors
- [ ] `turbo run test` — all tests pass
- [ ] Existing Riverside Aquarium venue works: chat responds with distance phrasing, location banner shows, location-aware quick prompts shown
- [ ] New non-location venue (Sappington House or manually created) can be created with `guideMode: non_location`
- [ ] Chat for non-location venue: no location banner, no GPS prompt, content-focused quick prompts
- [ ] Chat for non-location venue: sending a message returns a valid AI response (not an error)
- [ ] Chat for non-location venue: AI response does not contain distance phrasing ("right nearby", "feet away", "minute walk")
- [ ] Venue edit form for non-location venue shows the correct guide type selected
- [ ] Creating a guide item for a non-location venue with lat/lng = 0 works (Pass 1 limitation, fixed in Pass 2)

---

# PASS 2

**Only begin Pass 2 after all Pass 1 acceptance criteria are confirmed passing.**

Pass 2 introduces a TypeScript type cascade. After making `Place.lat` and `Place.lng` nullable, the TypeScript compiler will flag every location where these values are used as if they are guaranteed non-null numbers. Codex must resolve each type error before `turbo run typecheck` is clean.

**Expected files that will need type fixes after Task 11:**

- `packages/api/src/lib/geo.ts` — `findNearestPlaces` and `formatDistance` take `number` params; now receiving `number | null`
- `packages/db/src/helpers/semantic-search.ts` — may pass place coordinates to distance calc
- `packages/api/src/lib/venue-context.ts` — already guarded in Task 5, but confirm no remaining unguarded paths
- `packages/api/src/routers/chat.ts` — already guarded in Task 6, but confirm no remaining unguarded paths
- `apps/dashboard/components/PlaceForm.tsx` — form controller types for lat/lng change

After each Task 11–13, run `turbo run typecheck` and resolve all errors before proceeding.

---

### Task 11 — Make `Place.lat`/`lng` optional and add `itemType` in Prisma schema

**Goal:** Allow places to exist without coordinates. Add structured item type field.

**File:** `packages/db/prisma/schema.prisma`

**Changes in the `Place` model:**

1. Change `lat  Float` → `lat  Float?`
2. Change `lng  Float` → `lng  Float?`
3. Add `itemType  String?` after the `type` field

**Warning:** This change will immediately cause TypeScript errors in multiple files because `place.lat` and `place.lng` are now `number | null` instead of `number`. Do not proceed until you have identified and fixed all type errors. Run `turbo run typecheck` after each file you fix.

**Verification:** Run `prisma validate`. Then run `turbo run typecheck` and resolve every error before moving to Task 12.

---

### Task 12 — Generate and apply the Pass 2 migration

**Goal:** Apply the lat/lng nullable and itemType changes to the database.

**Run from:** `packages/db`

**Command:**

```bash
pnpm db:migrate --name optional_coords_and_item_type
```

**Expected SQL:**

```sql
ALTER TABLE "Place" ALTER COLUMN "lat" DROP NOT NULL;
ALTER TABLE "Place" ALTER COLUMN "lng" DROP NOT NULL;
ALTER TABLE "Place" ADD COLUMN "itemType" TEXT;
```

**Warning:** Do not edit an existing migration file. Confirm existing place rows still have their original lat/lng values after migration.

**Verification:** Apply migration. Confirm all existing Riverside Aquarium places still have their coordinates. Confirm seed runs cleanly.

---

### Task 13 — Update Place Zod schema

**Goal:** Allow coordinates to be optional and `itemType` to be accepted in API validation.

**File:** `packages/api/src/schemas/place.ts`

**Changes:**

In `CreatePlaceInput`:

- Change `lat: z.number()` → `lat: z.number().optional()`
- Change `lng: z.number()` → `lng: z.number().optional()`
- Add `itemType: z.enum(['physical_place', 'exhibit', 'room', 'sculpture', 'service_step', 'faq', 'amenity', 'policy', 'activity', 'general_info']).optional()`

In `UpdatePlaceInput`:

- Same lat/lng and itemType changes as above

**Warning:** Check whether there is a shared `PlaceInput` base type that `CreatePlaceInput` extends. If so, apply changes to the base type rather than duplicating.

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No errors.

---

### Task 14 — Update Place tRPC router to handle `itemType`

**Goal:** Persist and return `itemType` through place procedures.

**File:** `packages/api/src/routers/place.ts`

**Changes:**

1. In `create`: add `itemType: input.itemType` to `db.place.create`
2. In `update`: add `itemType: input.itemType` if provided
3. In `list` and `getById`: add `itemType` to the `select` clause

**Additional:** In `packages/api/src/lib/geo.ts`, update `findNearestPlaces` to filter out places where `lat == null || lng == null` before running the Haversine calculation. This prevents NaN distances if the function is ever called with a mixed set of places.

**Verification:** Run `pnpm --filter @pathfinder/api typecheck`. No errors.

---

### Task 15 — Update `PlaceForm` to conditionally show coordinates and add `itemType`

**Goal:** Remove coordinate requirement for non-location guide items. Add item type selector.

**File:** `apps/dashboard/components/PlaceForm.tsx`

**Changes:**

1. Add prop `venueGuideMode: 'location_aware' | 'non_location'` to `PlaceForm`.

2. Add `itemType` to form defaults: `itemType: place?.itemType ?? ''`

3. Add `itemType` dropdown field after `name`. Use a `<select>` with the values listed in section D.

4. Make lat/lng conditional:
   - `location_aware`: show as today, required
   - `non_location`: move to the advanced/collapsible section, optional, add helper text "Optional — only needed if this item has a physical location"

5. Update form validation: if `venueGuideMode === 'non_location'`, lat/lng should not be required.

6. Include `itemType` in submit payload.

**Warning:** Check the page at `apps/dashboard/app/venues/[venueId]/places/new/page.tsx`. It must fetch or receive `venue.guideMode` and pass it down to `PlaceForm`. If the venue is already fetched on that page, add `guideMode` to the select. If not, add a venue fetch.

**Also:** Update the seed data in `packages/db/prisma/seed.ts` — replace the `lat: 0, lng: 0` placeholders on Sappington House items with no lat/lng fields at all (now that the schema allows it).

**Verification:** Open place creation for a non-location venue. Confirm lat/lng are optional and in the advanced section. Create a guide item with no coordinates — it should succeed. Confirm Riverside Aquarium place creation still requires lat/lng.

---

### Task 16 — Relabel "Places" to "Guide Items" in dashboard UI

**Goal:** Show "Guide Items" everywhere user-visible in the dashboard.

**Scope:** `apps/dashboard/` only. User-visible text only.

**Search for and replace these exact strings:**

- `"Add Place"` → `"Add Guide Item"`
- `"New Place"` → `"New Guide Item"`
- `"Create Place"` → `"Create Guide Item"`
- `"Edit Place"` → `"Edit Guide Item"`
- `"No places"` → `"No guide items"`
- `"Places"` in nav links, page titles, breadcrumbs, section headings → `"Guide Items"`
- `"place"` (lowercase, user-visible) in `<h1>`, `<title>`, button text → `"guide item"`

**Do NOT change:**

- Route paths: `/places/`, `/places/new`, `/places/[placeId]`
- Prop names and variable names in code
- API procedure names (`place.create`, etc.)
- Prisma model name or router file names
- Anything in `packages/`

**Verification:** Navigate through the full dashboard UI. No user-visible "Place" or "Places" text remains. No broken routes or 404s.

---

### Pass 2 Acceptance Criteria

- [ ] `turbo run typecheck` — zero errors
- [ ] `turbo run lint` — zero errors
- [ ] `turbo run test` — all tests pass
- [ ] Guide items can be created for non-location venues without any lat/lng values
- [ ] Guide items saved with `lat: null, lng: null` still produce valid chat responses
- [ ] `itemType` can be set via the admin form and is stored/returned correctly
- [ ] Sappington House seed items have no coordinates (not `lat: 0`)
- [ ] All Pass 1 acceptance criteria still pass (regression check)
- [ ] Dashboard shows "Guide Items" everywhere user-visible; no user-facing "Place/Places" text remains
- [ ] Route paths (`/places/`, etc.) still work

---

## H. Acceptance Criteria (Combined)

The full implementation is complete when all of the following are true:

1. **Existing venues are unaffected.** The Riverside Aquarium demo venue works exactly as before.
2. **Existing places with coordinates still work** in all RAG, geo-distance, and chat flows.
3. **A new location-aware venue behaves as today:** coordinate inputs shown, location banner shown, location-aware quick prompts, distance phrasing in AI responses.
4. **A new non-location venue can be created** and stored with `guideMode: 'non_location'`.
5. **Guide items can be created without coordinates** for a non-location venue.
6. **Chat for non-location venues does not ask for user location.** No location banner, no GPS prompt.
7. **Non-location quick prompts are content-focused**, not navigation-focused.
8. **The AI for a non-location venue does not refer to distances.** No "right nearby," "feet away," or "minute walk."
9. **`itemType` can be set** via the admin form and is stored and returned.
10. **Dashboard UI reads "Guide Items"** everywhere user-visible. Route paths are unchanged.
11. **Typecheck, lint, and all tests pass** with zero errors.

---

## I. Risks and Mitigations

### Risk 1 — TypeScript type cascade from nullable lat/lng (Pass 2)

**Description:** Making `Place.lat` and `Place.lng` nullable changes their TypeScript type from `number` to `number | null` everywhere. Files that pass these values to functions expecting `number` will produce compile errors.

**Mitigation:** This is why Pass 2 is separate. Run `turbo run typecheck` after Task 11 and resolve all errors file-by-file before proceeding. Expected files needing fixes: `geo.ts`, `semantic-search.ts`, `venue-context.ts`, `chat.ts`, `PlaceForm.tsx`. The error list from `typecheck` is your complete task list — do not ship until it is empty.

---

### Risk 2 — Chat location error blocks all non-location venues (Pass 1, Task 6)

**Description:** The `send` procedure has a hard `throw` when location is unavailable. For non-location venues, this fires on every message. Task 6 fixes this, but if skipped or done incorrectly, no non-location venue can chat.

**Mitigation:** Task 6 is explicitly marked critical. After completing it, test by sending a chat message to a non-location venue with no lat/lng — confirm you receive an AI response, not an error.

---

### Risk 3 — Geo fallback produces NaN for places without coordinates (Pass 2)

**Description:** `findNearestPlaces` in `geo.ts` uses arithmetic on `place.lat`/`place.lng`. If these are null, the result is NaN, causing silent incorrect sorting.

**Mitigation:** Task 14 adds a `lat != null && lng != null` filter to `findNearestPlaces` before the distance calculation. The router-level guard in Task 6 also prevents this path from being reached for non-location venues, but the function-level guard provides defense in depth.

---

### Risk 4 — PlaceForm page does not have access to `venue.guideMode` (Pass 2)

**Description:** The place creation page needs `venueGuideMode` to render the correct form. If the page only uses the venueId from the URL and doesn't fetch venue details, `guideMode` will be unavailable.

**Mitigation:** Task 15 explicitly requires checking the place creation page and adding a venue fetch or field if needed. Do not assume the venue is already fetched there.

---

### Risk 5 — Existing tests assert lat/lng are required (Pass 2)

**Description:** Unit tests for `CreatePlaceInput` or the place router may assert that `lat` and `lng` are required. These will fail after Task 13.

**Mitigation:** Run `turbo run test` after Task 13. Find failing tests and update them to reflect that coordinates are optional. Keep tests for the coordinate-present creation path (location-aware venues still use coordinates).

---

### Risk 6 — Analytics events assume place coordinates exist (Pass 2)

**Description:** `emitEvent` calls that include place data may reference `place.lat`/`place.lng`. If these are null, analytics payloads could contain unexpected null values.

**Mitigation:** After Pass 2 tasks, grep for `emitEvent` calls that include place data. Add null guards on coordinate fields in those payloads. Non-location venues simply will not have geo data in analytics — this is expected.

---

## J. Optional Follow-Up Enhancements

These are NOT part of the MVP and should be separate implementation packets.

### J.1 — Language selector in visitor chat

**Description:** A visible language toggle (English, Spanish, Arabic, Auto-detect). The infrastructure already exists — `language` is already a parameter in `chat.send` and `buildVenueSystemPrompt`. Only a UI selector is missing.

**Priority:** High for St. Anthony's Food Pantry pilot.  
**Estimate:** Small — 1–2 tasks.

---

### J.2 — QR codes that deep-link to a specific guide item

**Description:** Each sculpture, exhibit, or room gets its own QR code that opens chat with pre-loaded context for that item. Especially useful for Laumeier Sculpture Park.

**Estimate:** Medium — URL parameter handling in chat page + system prompt.

---

### J.3 — Venue templates for faster onboarding

**Description:** Pre-filled structures for sculpture park, historic house, food pantry. Reduces friction for new venue creators.

**Estimate:** Medium — UI work plus template data.

---

### J.4 — Remove lat/lng = 0 placeholders from non-location venues

**Description:** After Pass 2 is deployed, the Sappington House seed and any real venues created during Pass 1 with `lat: 0` placeholders should have their coordinates cleared to `null`. This is a one-time data cleanup.

**Estimate:** Very small — one migration or seed update.

---

### J.5 — Analytics by guide item / itemType

**Description:** Dashboard analytics broken down by `itemType`.

**Estimate:** Medium — analytics schema + dashboard UI.

---

### J.6 — Public venue preview / demo mode

**Description:** A shareable preview link for venue creators to test before publishing.

**Estimate:** Medium — new route, access control changes.

---

_End of implementation packet. Execute Pass 1 completely (Tasks 1–10) and verify all Pass 1 acceptance criteria before starting Pass 2 (Tasks 11–16). Any ambiguity is documented as a warning within the relevant task._
