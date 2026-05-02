# Codex Implementation Packet — Guest Chat Language Picker

## What to build

Add a language selector to the guest chat page so visitors can explicitly choose the language they want to receive AI responses in. The selected language is stored in `localStorage` and passed to the AI on every message so responses are always in the chosen language regardless of what language the guest types in.

---

## Context you must read before writing any code

- `CLAUDE.md` — project engineering constitution (rules, patterns, forbidden anti-patterns)
- `packages/api/src/routers/chat.ts` — the `send` mutation, `sendMessageSchema`
- `packages/api/src/lib/venue-context.ts` — `buildVenueSystemPrompt`, where the language rule lives
- `apps/web/app/[venueSlug]/chat/page.tsx` — the guest chat page, `handleSend` function
- `apps/web/components/ChatWindow.tsx` — the chat UI component

---

## Exact file changes required

### 1. `packages/api/src/routers/chat.ts`

**Add `language` to `sendMessageSchema`.**

Find the `sendMessageSchema` object (around line 51) and add one field:

```ts
const sendMessageSchema = z
  .object({
    venueId: z.string().cuid(),
    anonymousToken: z.string().uuid(),
    message: z.string().min(1).max(1000),
    lat: z.number(),
    lng: z.number(),
    language: z.string().max(50).optional(), // e.g. "Spanish", "French"
  })
  .strict()
```

**Pass `language` into `buildVenueSystemPrompt`.**

In the `send` mutation, find the call to `buildVenueSystemPrompt` (around line 262) and add the language field:

```ts
const systemPrompt = buildVenueSystemPrompt({
  venue,
  relevantPlaces,
  userLat: input.lat,
  userLng: input.lng,
  featuredPlace,
  language: input.language, // add this line
})
```

No other changes to `chat.ts`.

---

### 2. `packages/api/src/lib/venue-context.ts`

**Add `language` param to `buildVenueSystemPrompt`.**

Update the function signature to accept an optional `language` param:

```ts
export function buildVenueSystemPrompt(params: {
  venue: VenueInfo
  relevantPlaces: RelevantPlace[]
  userLat: number
  userLng: number
  featuredPlace?: FeaturedPlace | null
  language?: string | null   // add this
}): string {
  const { venue, relevantPlaces, featuredPlace, language } = params
```

**Replace the existing `languageRule` constant** (the block that starts with `// Keep Claude aligned...` around line 82) with this new version that uses the explicit language when provided, and falls back to auto-detection otherwise:

```ts
const languageRule =
  language && language.trim().length > 0
    ? `LANGUAGE RULE: The guest has selected ${language} as their preferred language. Always respond in ${language}, regardless of what language the guest types in.`
    : "LANGUAGE RULE: Detect the language of the guest's message. Always reply in the same language the guest uses. If the guest writes in Spanish, reply in Spanish. If French, reply in French. Do not switch languages mid-conversation unless the guest switches first. Default to English if the language is unclear."
```

No other changes to `venue-context.ts`.

---

### 3. `apps/web/components/LanguagePicker.tsx` — **new file**

Create this component in `apps/web/components/`. It renders a compact dropdown of supported languages. When the user selects one it calls `onChange` and also writes the value to `localStorage` under the key `pathfinder_language`.

```tsx
'use client'

import { Globe } from 'lucide-react'

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ar', label: 'العربية' },
]

const STORAGE_KEY = 'pathfinder_language'

export function getStoredLanguage(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem(STORAGE_KEY)
}

type LanguagePickerProps = {
  value: string
  onChange: (language: string) => void
  accentColor?: string
}

export function LanguagePicker({ value, onChange, accentColor = '#3A7BD5' }: LanguagePickerProps) {
  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = e.target.value
    localStorage.setItem(STORAGE_KEY, selected)
    onChange(selected)
  }

  return (
    <div className="flex items-center gap-1.5">
      <Globe className="h-3.5 w-3.5 text-pf-deep/40 flex-shrink-0" aria-hidden="true" />
      <select
        value={value}
        onChange={handleChange}
        className="bg-transparent text-xs text-pf-deep/60 border-none outline-none cursor-pointer hover:text-pf-deep focus:text-pf-deep transition-colors appearance-none pr-1"
        aria-label="Select language"
        style={{ accentColor }}
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.label}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  )
}
```

---

### 4. `apps/web/app/[venueSlug]/chat/page.tsx`

This is the main integration point. Make three changes:

#### 4a. Add imports at the top of the file

```tsx
import {
  getStoredLanguage,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from '../../../components/LanguagePicker'
```

#### 4b. Add `language` state inside `VenueChatPage`

Add this after the existing `useState` declarations (e.g. after `const [sendError, setSendError] = useState<string | null>(null)`):

```tsx
const [language, setLanguage] = useState<string>(() => {
  const stored = getStoredLanguage()
  const match = SUPPORTED_LANGUAGES.find((l) => l.label === stored)
  return match ? match.label : 'English'
})
```

#### 4c. Pass `language` in the `handleSend` call

Find the `client.chat.send.mutate(...)` call inside `handleSend` and add the `language` field:

```ts
const result = await client.chat.send.mutate({
  venueId: venue.id,
  anonymousToken,
  message: trimmed,
  lat: fallbackLat,
  lng: fallbackLng,
  language, // add this line
})
```

#### 4d. Render the `LanguagePicker` in the header

Inside the `<header>` section, find the `<div className="mx-auto max-w-2xl py-4">` wrapper. Add the `LanguagePicker` as a row below the guide name, right before the category tag. It should sit inline at the bottom of the header block. The exact placement is after the `<h1>` that renders `{guideName}` and before the `{venue.category ? ...}` block:

```tsx
<div className="mt-2 flex items-center justify-between">
  <LanguagePicker value={language} onChange={setLanguage} accentColor={accent} />
</div>
```

Place this new `<div>` between the `<div className="mt-2 flex items-center gap-3">` block (the logo + guide name row) and the category `<p>` tag.

---

## What NOT to do

- Do not add a new database table or migration. Language preference is ephemeral state — `localStorage` is sufficient.
- Do not store language in the `VisitorSession` row. It is not needed server-side beyond the current request.
- Do not add language to the `history` query or load it from the server. The picker initialises from `localStorage` on mount.
- Do not change the `LANGUAGE RULE` in `venue-context.ts` for the no-language case — keep auto-detection as the fallback.
- Do not use `next/image` for any icons. Use `lucide-react` (`Globe` icon is already in the dependency).
- Do not create a custom styled `<select>` with a portal or third-party dropdown library. The native `<select>` is intentional — it is accessible, works on mobile keyboards, and needs no extra dependencies.

---

## Acceptance criteria

1. The chat header shows a globe icon + language dropdown.
2. The dropdown defaults to "English" for new visitors.
3. If a visitor previously selected a language, the dropdown restores that selection on page load (from `localStorage`).
4. Changing the language dropdown immediately affects the next message sent — no page reload needed.
5. When a language other than English is selected, Claude responds in that language regardless of what language the visitor types in.
6. When "English" is selected (the default), Claude auto-detects from the visitor's message as before.
7. `turbo run typecheck` passes with zero errors.
8. `turbo run lint` passes with zero errors.
