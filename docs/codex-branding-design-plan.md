# PathFinder — Branding & Chatbot Design Implementation Plan

Execute every phase in order. Run `turbo run typecheck` and `turbo run test` after all phases complete.

---

## Phase 0 — Replace broken SVG assets

Both `/apps/web/public/pathfinder-icon.svg` and `/apps/web/public/pathfinder-logo.svg` are
multi-megabyte base64-encoded PNGs wrapped in an `<svg>` shell. Replace them with proper
lightweight files.

### 0a — Overwrite `apps/web/public/pathfinder-icon.svg`

Replace the entire file with this clean map-pin SVG (keep the same filename):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <path fill="#1F4E8C" d="M16 3C10.477 3 6 7.477 6 13c0 3.09 1.38 5.857 3.563 7.746L16 29l6.437-8.254A9.956 9.956 0 0 0 26 13c0-5.523-4.477-10-10-10z"/>
  <circle fill="white" cx="16" cy="13" r="3.5"/>
</svg>
```

### 0b — Overwrite `apps/web/public/pathfinder-logo.svg`

Replace with a simple wordmark so the file exists but shows nothing (all logo display is now
done via JSX — see Phase 1). This prevents 404 errors from any stale reference:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>
```

---

## Phase 1 — Fix broken logos in dashboard and web chat landing page

### 1a — Dashboard sidebar logo

**File:** `apps/dashboard/components/DashboardShell.tsx`

Find:

```tsx
<img src="/pathfinder-logo.svg" alt="PathFinder" className="h-7 w-auto" />
```

Replace with (the sidebar has `bg-pf-deep` so text should be white):

```tsx
<div className="flex items-center gap-2">
  <img src="/pathfinder-icon.svg" alt="" className="h-7 w-7" />
  <span className="text-base font-semibold text-pf-white">PathFinder</span>
</div>
```

### 1b — Web venue landing page logo

**File:** `apps/web/app/[venueSlug]/page.tsx`

The file uses `<Image src="/pathfinder-icon.svg" .../>` which now has a proper lightweight SVG
behind it after Phase 0. No JSX changes needed — verify it renders after deployment.

---

## Phase 2 — Fix "Open your guide" navigation bug

### Problem

Sequence that fails:

1. Dashboard "Test AI chat" opens `/{slug}/chat` in a new tab.
2. User clicks the "← Back" link (Next.js `<Link>`) inside the chat page, lands on `/{slug}`.
3. User clicks "Open your guide" → navigates to `/{slug}/chat` → chat page shows
   "We could not find this venue."

### Root cause

The `useApiClient` hook in the chat page stores the tRPC client in a `useRef`. On every
fresh mount the ref is `null` and a new client is created. The client uses a bare relative
URL `'/api/trpc'`. In some browsers, when a page was originally reached via an
`_blank` external navigation (no same-origin history), subsequent client-side navigations
can cause the relative URL resolution to fail or fire before the component is fully hydrated.

Additionally, there is no retry mechanism — a single thrown error permanently shows the
error state for that mount.

### Fix

**File:** `apps/web/app/[venueSlug]/chat/page.tsx`

**Change 1 — Make the tRPC URL absolute.**

Find the `useApiClient` function and the `createTRPCClient` call. Locate
`apps/web/lib/trpc.ts` and change `url: TRPC_ENDPOINT` to include the origin:

```ts
// apps/web/lib/trpc.ts
export function createTRPCClient() {
  const base =
    typeof window !== 'undefined' ? window.location.origin : (process.env.NEXT_PUBLIC_WEB_URL ?? '')

  return createTRPCCoreClient<AppRouter>({
    links: [
      loggerLink({
        enabled: (options) =>
          process.env.NODE_ENV === 'development' ||
          (options.direction === 'down' && options.result instanceof Error),
      }),
      httpBatchLink({
        transformer: superjson,
        url: `${base}${TRPC_ENDPOINT}`,
      }),
    ],
  })
}
```

**Change 2 — Add a retry button on the error state.**

In `apps/web/app/[venueSlug]/chat/page.tsx`, find the `!venue` early-return block:

```tsx
if (!venue) {
  return (
    <main ...>
      <div ...>
        <h1 ...>Venue unavailable</h1>
        <p ...>{pageError ?? 'This venue link is not active.'}</p>
        <Link href="/" ...>Back to home</Link>
      </div>
    </main>
  )
}
```

Replace with (adds a retry button that calls `window.location.reload()`):

```tsx
if (!venue) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
      <div className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold text-pf-deep">Venue unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/60">
          {pageError ?? 'This venue link is not active.'}
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  )
}
```

---

## Phase 3 — Database migration

Create migration file `packages/db/prisma/migrations/007_venue_branding/migration.sql`:

```sql
-- Migration 007: venue branding & AI guide name
-- Adds custom AI guide name, chat theme, accent colour, logo URL, and banner URL to venues.

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS ai_guide_name    TEXT,
  ADD COLUMN IF NOT EXISTS chat_theme       TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS chat_accent_color TEXT,
  ADD COLUMN IF NOT EXISTS chat_logo_url    TEXT,
  ADD COLUMN IF NOT EXISTS chat_banner_url  TEXT;
```

---

## Phase 4 — Prisma schema update

**File:** `packages/db/prisma/schema.prisma`

Inside the `Venue` model, after the `aiTone` field, add:

```prisma
  aiGuideName      String?  @map("ai_guide_name")
  chatTheme        String?  @default("default") @map("chat_theme")
  chatAccentColor  String?  @map("chat_accent_color")
  chatLogoUrl      String?  @map("chat_logo_url")
  chatBannerUrl    String?  @map("chat_banner_url")
```

Run `pnpm --filter @pathfinder/db db:generate` (or the equivalent `prisma generate`) after
updating the schema. Do **not** run `db:migrate` against the production database — apply the
SQL from Phase 3 directly.

---

## Phase 5 — API layer changes

### 5a — Extend `venueAiConfigSelect` and `updateAiConfig`

**File:** `packages/api/src/routers/venue.ts`

**Change 1 — `venueAiConfigSelect`** (currently selects `aiGuideNotes`, `aiFeaturedPlaceId`, `aiTone`):

```ts
const venueAiConfigSelect = {
  aiGuideNotes: true,
  aiFeaturedPlaceId: true,
  aiTone: true,
  aiGuideName: true,
} as const
```

**Change 2 — `updateAiConfig` input schema**, add `aiGuideName`:

```ts
z.object({
  venueId: z.string().cuid(),
  aiGuideNotes: z.string().max(2000).nullable().optional(),
  aiFeaturedPlaceId: z.string().cuid().nullable().optional(),
  aiTone: z.enum(['FRIENDLY', 'PROFESSIONAL', 'PLAYFUL']).optional(),
  aiGuideName: z.string().max(80).nullable().optional(),
}).strict()
```

### 5b — New `updateChatDesign` mutation

**File:** `packages/api/src/routers/venue.ts`

Add this procedure inside the `venueRouter`, after `updateAiConfig`:

```ts
updateChatDesign: tenantProcedure
  .use(requireRole('MANAGER'))
  .input(
    z.object({
      venueId: z.string().cuid(),
      chatTheme: z.enum(['default', 'forest', 'sunset', 'midnight', 'rose']).optional(),
      chatAccentColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex colour e.g. #3A7BD5')
        .nullable()
        .optional(),
      chatLogoUrl: z.string().url().max(500).nullable().optional(),
      chatBannerUrl: z.string().url().max(500).nullable().optional(),
    }).strict(),
  )
  .mutation(async ({ ctx, input }) => {
    const tenantId = ctx.session.activeTenantId

    const venue = await ctx.db.venue.findFirst({
      where: { id: input.venueId, tenantId },
      select: { id: true },
    })

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    const { venueId: _venueId, ...raw } = input
    const data = Object.fromEntries(
      Object.entries(raw).filter(([, value]) => value !== undefined),
    )

    await ctx.db.venue.updateMany({
      where: { id: input.venueId, tenantId },
      data,
    })

    const updated = await ctx.db.venue.findFirst({
      where: { id: input.venueId, tenantId },
      select: {
        chatTheme: true,
        chatAccentColor: true,
        chatLogoUrl: true,
        chatBannerUrl: true,
      },
    })

    if (!updated) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    try {
      await emitEvent({
        tenantId,
        venueId: input.venueId,
        sessionId: '',
        eventType: 'venue.updated',
      })
    } catch {}

    return updated
  }),
```

### 5c — Extend `getBySlug` to return branding fields

**File:** `packages/api/src/routers/venue.ts`

The `getBySlug` query uses raw SQL. Extend the SELECT and the return type:

```ts
getBySlug: publicProcedure
  .input(z.object({ slug: z.string().min(1) }))
  .query(async ({ ctx, input }) => {
    const [venue] = await ctx.db.$queryRaw<
      {
        id: string
        name: string
        description: string | null
        category: string | null
        defaultCenterLat: number | null
        defaultCenterLng: number | null
        aiGuideName: string | null
        chatTheme: string | null
        chatAccentColor: string | null
        chatLogoUrl: string | null
        chatBannerUrl: string | null
      }[]
    >`
      SELECT id, name, description, category,
             default_center_lat    AS "defaultCenterLat",
             default_center_lng    AS "defaultCenterLng",
             ai_guide_name         AS "aiGuideName",
             chat_theme            AS "chatTheme",
             chat_accent_color     AS "chatAccentColor",
             chat_logo_url         AS "chatLogoUrl",
             chat_banner_url       AS "chatBannerUrl"
      FROM venues WHERE slug = ${input.slug} AND is_active = true LIMIT 1
    `

    if (!venue) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
    }

    return venue
  }),
```

### 5d — Update `buildVenueSystemPrompt` to use custom guide name

**File:** `packages/api/src/lib/venue-context.ts`

Update the `VenueInfo` type and the prompt text:

```ts
type VenueInfo = {
  name: string
  description: string | null
  category: string | null
  guideNotes?: string | null
  aiGuideNotes?: string | null
  aiTone?: string | null
  aiGuideName?: string | null // ADD THIS
}
```

In `buildVenueSystemPrompt`, change the first line of the returned prompt:

```ts
const guideName = params.venue.aiGuideName?.trim() || 'Path Finder'

return `You are ${guideName}, a helpful on-site guide for ${venue.name}.
```

### 5e — Update `chat.ts` to pass `aiGuideName` through

**File:** `packages/api/src/routers/chat.ts`

The `venue` query already uses `$queryRaw` with a named column list. Add `ai_guide_name` to
the SELECT and the type annotation, then pass it into `buildVenueSystemPrompt`.

In the `send` procedure, find the `$queryRaw` for venue and add:

```sql
ai_guide_name AS "aiGuideName",
```

Add `aiGuideName: string | null` to the inline type. The `venue` object is passed directly
to `buildVenueSystemPrompt({ venue, ... })` so the new field flows through automatically.

---

## Phase 6 — Dashboard: AI Controls — add guide name field

**File:** `apps/dashboard/components/AiControlsForm.tsx`

### 6a — Add `aiGuideName` to local form state

Find the state declarations near the top of the component. Add:

```ts
const [aiGuideName, setAiGuideName] = useState(initialVenue?.aiGuideName ?? '')
```

(The `initialVenue` prop comes from the page that pre-fetches `venue.getAiConfig`.)

### 6b — Include `aiGuideName` in the save mutation call

Find the `client.venue.updateAiConfig.mutate(...)` call and add:

```ts
aiGuideName: aiGuideName.trim() || null,
```

### 6c — Add the form field

Add a new section in the form, above the "Operator Guide Notes" textarea:

```tsx
{
  /* Guide name */
}
;<div>
  <label htmlFor="ai-guide-name" className="block text-sm font-semibold text-pf-deep">
    Guide name
  </label>
  <p className="mt-1 text-xs leading-5 text-pf-deep/50">
    What the AI calls itself when guests chat. Leave blank to use the default "Path Finder".
  </p>
  <input
    id="ai-guide-name"
    type="text"
    maxLength={80}
    placeholder="e.g. Riverside Zoo Guide"
    value={aiGuideName}
    onChange={(e) => setAiGuideName(e.target.value)}
    className="mt-3 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
  />
</div>
```

### 6d — Initialise `aiGuideName` from the page props

**File:** `apps/dashboard/app/(app)/ai-controls/page.tsx`

The page fetches `venue.getAiConfig` server-side and passes the result to `AiControlsForm`.
After Phase 5a adds `aiGuideName` to `venueAiConfigSelect`, the fetched config will include
it. Pass it through to the form component.

---

## Phase 7 — Dashboard: new "Chatbot Design" tab

### 7a — Add navigation item

**File:** `apps/dashboard/components/DashboardShell.tsx`

Add `Palette` to the lucide-react import, then add to `navigationItems`:

```ts
import { Bot, Building2, ChartColumn, Home, LogOut, Megaphone, Palette } from 'lucide-react'

const navigationItems = [
  { href: '/', label: 'Overview', icon: Home },
  { href: '/venues', label: 'Venues', icon: Building2 },
  { href: '/analytics', label: 'Analytics', icon: ChartColumn },
  { href: '/ai-controls', label: 'AI Controls', icon: Bot },
  { href: '/chat-design', label: 'Chatbot Design', icon: Palette },
  { href: '/operational-updates', label: 'Operational Updates', icon: Megaphone },
] as const
```

### 7b — Create the page

**File:** `apps/dashboard/app/(app)/chat-design/page.tsx`

This is a server component that fetches venue list, then renders the client form.

```tsx
import { TRPCError } from '@trpc/server'
import { appRouter, createTRPCContext } from '@pathfinder/api'
import { ChatDesignForm } from '../../../components/ChatDesignForm'

export default async function ChatDesignPage() {
  const ctx = await createTRPCContext({
    req: new Request('https://dashboard.pathfinder.local/chat-design'),
  })
  const caller = appRouter.createCaller(ctx)

  let venues: Awaited<ReturnType<typeof caller.venue.list>> = []
  try {
    venues = await caller.venue.list()
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error
  }

  return (
    <div className="px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-pf-deep">Chatbot Design</h1>
          <p className="mt-2 text-sm leading-6 text-pf-deep/60">
            Customise how your guest chat looks — colours, logo, and header image.
          </p>
        </div>
        <ChatDesignForm venues={venues} />
      </div>
    </div>
  )
}
```

### 7c — Create the form component

**File:** `apps/dashboard/components/ChatDesignForm.tsx`

```tsx
'use client'

import Image from 'next/image'
import { useState } from 'react'
import { createTRPCClient } from '../lib/trpc'

type Venue = {
  id: string
  name: string
  slug: string
}

type ChatDesignFormProps = {
  venues: Venue[]
}

const THEMES = [
  { value: 'default', label: 'PathFinder Blue', accent: '#3A7BD5', surface: '#F2F5F9' },
  { value: 'forest', label: 'Forest', accent: '#2D6A4F', surface: '#F0F7F4' },
  { value: 'sunset', label: 'Sunset', accent: '#E07B39', surface: '#FBF4EF' },
  { value: 'midnight', label: 'Midnight', accent: '#4361EE', surface: '#EEF0F8' },
  { value: 'rose', label: 'Rose', accent: '#D4607A', surface: '#FDF0F3' },
] as const

type ThemeValue = (typeof THEMES)[number]['value']

function useApiClient() {
  // module-level singleton pattern matching the chat page
  return createTRPCClient()
}

export function ChatDesignForm({ venues }: ChatDesignFormProps) {
  const client = useApiClient()

  const [selectedVenueId, setSelectedVenueId] = useState(venues[0]?.id ?? '')
  const [chatTheme, setChatTheme] = useState<ThemeValue>('default')
  const [chatAccentColor, setChatAccentColor] = useState('')
  const [chatLogoUrl, setChatLogoUrl] = useState('')
  const [chatBannerUrl, setChatBannerUrl] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const previewAccent = chatAccentColor.match(/^#[0-9A-Fa-f]{6}$/)
    ? chatAccentColor
    : (THEMES.find((t) => t.value === chatTheme)?.accent ?? '#3A7BD5')

  async function handleSave() {
    if (!selectedVenueId || isSaving) return
    setSaveError(null)
    setSaved(false)
    setIsSaving(true)

    try {
      await client.venue.updateChatDesign.mutate({
        venueId: selectedVenueId,
        chatTheme,
        chatAccentColor: chatAccentColor.match(/^#[0-9A-Fa-f]{6}$/) ? chatAccentColor : null,
        chatLogoUrl: chatLogoUrl.trim() || null,
        chatBannerUrl: chatBannerUrl.trim() || null,
      })
      setSaved(true)
    } catch {
      setSaveError('Failed to save. Please try again.')
    } finally {
      setIsSaving(false)
    }
  }

  if (venues.length === 0) {
    return <p className="text-sm text-pf-deep/50">No venues found. Create a venue first.</p>
  }

  return (
    <div className="space-y-8">
      {/* Venue selector */}
      {venues.length > 1 && (
        <div>
          <label className="block text-sm font-semibold text-pf-deep" htmlFor="design-venue">
            Venue
          </label>
          <select
            id="design-venue"
            value={selectedVenueId}
            onChange={(e) => setSelectedVenueId(e.target.value)}
            className="mt-2 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Theme picker */}
      <div>
        <p className="text-sm font-semibold text-pf-deep">Colour theme</p>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Choose a preset. The custom colour below overrides the accent colour.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => setChatTheme(theme.value)}
              className={[
                'rounded-2xl border p-4 text-left transition',
                chatTheme === theme.value
                  ? 'border-pf-accent bg-pf-accent/5 ring-2 ring-pf-accent/30'
                  : 'border-pf-light bg-pf-white hover:border-pf-accent/50',
              ].join(' ')}
            >
              <div
                className="h-6 w-6 rounded-full"
                style={{ backgroundColor: theme.accent }}
                aria-hidden="true"
              />
              <p className="mt-2 text-xs font-medium text-pf-deep">{theme.label}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Custom accent colour */}
      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="accent-color">
          Custom accent colour
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Hex value e.g. <code>#3A7BD5</code>. Overrides the theme accent. Leave blank to use the
          theme colour.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <input
            id="accent-color"
            type="text"
            placeholder="#3A7BD5"
            value={chatAccentColor}
            maxLength={7}
            onChange={(e) => setChatAccentColor(e.target.value)}
            className="w-40 rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 font-mono text-sm text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
          />
          <div
            className="h-10 w-10 flex-shrink-0 rounded-full border border-pf-light"
            style={{ backgroundColor: previewAccent }}
            aria-label="Colour preview"
          />
        </div>
      </div>

      {/* Logo URL */}
      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="chat-logo-url">
          Your logo URL
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Link to your logo image (PNG or SVG, square crop recommended). Shown in the chat header
          instead of the PathFinder icon.
        </p>
        <input
          id="chat-logo-url"
          type="url"
          placeholder="https://yoursite.com/logo.png"
          value={chatLogoUrl}
          onChange={(e) => setChatLogoUrl(e.target.value)}
          className="mt-3 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
        {chatLogoUrl && (
          <div className="mt-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={chatLogoUrl}
              alt="Logo preview"
              className="h-10 w-10 rounded-xl border border-pf-light object-contain"
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
            <p className="text-xs text-pf-deep/50">Preview</p>
          </div>
        )}
      </div>

      {/* Banner URL */}
      <div>
        <label className="block text-sm font-semibold text-pf-deep" htmlFor="chat-banner-url">
          Chat header background image URL
        </label>
        <p className="mt-1 text-xs leading-5 text-pf-deep/50">
          Optional banner/background image shown behind the venue name in the chat header. Wide
          landscape images (at least 800×200 px) work best.
        </p>
        <input
          id="chat-banner-url"
          type="url"
          placeholder="https://yoursite.com/banner.jpg"
          value={chatBannerUrl}
          onChange={(e) => setChatBannerUrl(e.target.value)}
          className="mt-3 w-full rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-sm text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
        />
      </div>

      {/* Save */}
      {saveError && (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {saveError}
        </p>
      )}
      {saved && (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          Design saved. Changes will appear in the guest chat immediately.
        </p>
      )}

      <button
        type="button"
        disabled={isSaving || !selectedVenueId}
        onClick={handleSave}
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-6 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSaving ? 'Saving…' : 'Save design'}
      </button>
    </div>
  )
}
```

---

## Phase 8 — Chat page: apply branding and guide name

**File:** `apps/web/app/[venueSlug]/chat/page.tsx`

### 8a — Extend the `VenueSummary` type

Add the branding fields to the local `VenueSummary` type (this mirrors what `getBySlug` now
returns after Phase 5c):

```ts
type VenueSummary = {
  id: string
  name: string
  description: string | null
  category: string | null
  defaultCenterLat: number | null
  defaultCenterLng: number | null
  aiGuideName: string | null
  chatTheme: string | null
  chatAccentColor: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
}
```

### 8b — Inject theme CSS variables

Add a helper near the top of the file (outside the component):

```ts
const THEME_PRESETS: Record<string, { accent: string; surface: string }> = {
  default: { accent: '#3A7BD5', surface: '#F2F5F9' },
  forest: { accent: '#2D6A4F', surface: '#F0F7F4' },
  sunset: { accent: '#E07B39', surface: '#FBF4EF' },
  midnight: { accent: '#4361EE', surface: '#EEF0F8' },
  rose: { accent: '#D4607A', surface: '#FDF0F3' },
}

function getThemeColors(venue: VenueSummary) {
  const preset = THEME_PRESETS[venue.chatTheme ?? 'default'] ?? THEME_PRESETS.default
  return {
    accent: venue.chatAccentColor ?? preset.accent,
    surface: preset.surface,
  }
}
```

### 8c — Render theme and branding

Inside `VenueChatPage`, after `venue` is non-null, derive colors and guide name:

```ts
const { accent, surface } = getThemeColors(venue)
const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
```

Add a `<style>` tag as the first child of the outer `<div>` to inject CSS variables:

```tsx
<div className="flex min-h-screen flex-col bg-pf-surface" style={{ backgroundColor: surface }}>
  <style>{`
    :root {
      --chat-accent: ${accent};
      --chat-surface: ${surface};
    }
  `}</style>
```

### 8d — Update the chat page header

Replace the existing `<header>` block:

```tsx
<header
  className="border-b border-black/10 bg-pf-white px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6"
  style={
    venue.chatBannerUrl
      ? {
          backgroundImage: `url(${venue.chatBannerUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }
      : undefined
  }
>
  <div className="mx-auto max-w-2xl py-4">
    <Link
      href={`/${venueSlug}`}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-pf-deep/40 transition hover:text-pf-primary"
    >
      <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path
          fillRule="evenodd"
          d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
          clipRule="evenodd"
        />
      </svg>
      Back
    </Link>
    <div className="mt-2 flex items-center gap-3">
      {venue.chatLogoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={venue.chatLogoUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
      ) : (
        <Image src="/pathfinder-icon.svg" alt="" width={28} height={28} />
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-pf-deep">{guideName}</h1>
    </div>
    {venue.category ? (
      <p className="mt-1 text-xs font-semibold uppercase tracking-widest" style={{ color: accent }}>
        {venue.category.toLowerCase().replace(/_/g, ' ')}
      </p>
    ) : null}
  </div>
</header>
```

### 8e — Apply accent colour to the send button

In `ChatWindow.tsx` (`apps/web/components/ChatWindow.tsx`), the send button currently uses
hardcoded `bg-pf-primary hover:bg-pf-accent`. Change the button and user message bubble to
accept optional `accentColor` prop:

**`ChatWindow` props type:**

```ts
type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  isLoading: boolean
  errorMessage?: string | null
  accentColor?: string // ADD
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
}
```

Pass `accentColor` to `ChatWindow` from the chat page:

```tsx
<ChatWindow
  messages={messages}
  onSend={...}
  isLoading={isSending}
  errorMessage={sendError}
  accentColor={accent}
  ...
/>
```

In `ChatWindow`, apply the accent to the send button and user message bubble via `style`:

Send button:

```tsx
<button
  ...
  style={{ backgroundColor: accentColor ?? undefined }}
  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-pf-light disabled:text-pf-deep/30"
>
```

User message bubble in `MessageBubble.tsx` — pass `accentColor` down and apply similarly. If
`MessageBubble` doesn't accept props for this, add a prop `bubbleColor?: string` and apply it
with `style={{ backgroundColor: bubbleColor ?? undefined }}` on the user bubble `<div>`.

---

## Phase 9 — Verification checklist

- [ ] `turbo run typecheck` — zero errors
- [ ] `turbo run lint` — zero errors
- [ ] `turbo run test` — all tests pass (especially `_admin.test.ts` and `place.test.ts`)
- [ ] Dashboard logo renders correctly in the sidebar
- [ ] Venue landing page icon renders correctly
- [ ] Chat loading spinner icon renders correctly
- [ ] "Open your guide" navigation works after back → reload cycle
- [ ] AI Controls form shows the Guide name field and saves correctly
- [ ] Chatbot Design page is accessible from the dashboard sidebar
- [ ] Saving a theme/colour/logo in Chatbot Design updates the chat page on next load
- [ ] Guide name appears in the chat header (not "{venue.name} Guide" when custom name set)
- [ ] Custom accent colour applies to send button and user bubbles

---

## Notes for Codex

- Do not use `db.$queryRaw` without explicit `tenant_id` bind in tenanted queries. The
  `getBySlug` query is exempt (cross-tenant public lookup — follows existing pattern).
- The `chatTheme` / `chatAccentColor` / `chatLogoUrl` / `chatBannerUrl` fields on Venue are
  NOT tenanted fields (they are on the Venue model which is already tenant-scoped). Do not
  add them to the tenant isolation middleware table list.
- All mutations that take `venueId` must verify `venue.tenantId === ctx.session.activeTenantId`
  via Prisma query — the new `updateChatDesign` mutation does this via `findFirst`.
- The `ChatDesignForm` component belongs in `apps/dashboard/components/` (used by one app only).
- Do not create a `packages/ui` component for `ChatDesignForm` — it is dashboard-only.
- The `<style>` injection in the chat page uses CSS custom properties at `:root`. This is
  safe; it is scoped to the current tab and overrides are intentional.
- Avoid adding a new icon library. The `Palette` icon used in DashboardShell is from
  `lucide-react` which is already installed.
