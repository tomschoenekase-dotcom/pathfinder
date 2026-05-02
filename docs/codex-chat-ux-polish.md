# Codex Implementation Packet — Chat Page UX Polish

## What to build

Three small changes to the guest chat page (`apps/web/app/[venueSlug]/chat/page.tsx`) and its supporting components:

1. **Remove the venue category label** from the chat header (the small "PARK" / "MUSEUM" / etc. tag under the guide name).
2. **Style the language picker as a visible pill button** so guests can clearly see it is interactive.
3. **When a non-English language is selected**: hide the quick-prompt chips, and update the textarea placeholder text to be written in that language.

---

## Context you must read before writing any code

- `CLAUDE.md` — project engineering constitution
- `apps/web/app/[venueSlug]/chat/page.tsx` — the guest chat page (all changes flow from here)
- `apps/web/components/LanguagePicker.tsx` — the language picker component built in the previous sprint
- `apps/web/components/ChatWindow.tsx` — owns the textarea and its placeholder
- `apps/web/components/QuickPromptChips.tsx` — the suggested question chips

---

## Exact file changes required

### 1. `apps/web/app/[venueSlug]/chat/page.tsx` — remove category label

Find this block (it is the last element inside the `<div className="mx-auto max-w-2xl py-4">` wrapper in the `<header>`):

```tsx
{
  venue.category ? (
    <p
      className="mt-1 text-xs font-semibold uppercase tracking-widest"
      style={{ color: venue.chatBannerUrl ? '#FFFFFF' : accent }}
    >
      {venue.category.toLowerCase().replace(/_/g, ' ')}
    </p>
  ) : null
}
```

**Delete it entirely.** Do not replace it with anything.

---

### 2. `apps/web/components/LanguagePicker.tsx` — pill button styling + placeholder map

#### 2a. Add a placeholder translations map

Add this constant near the top of the file, after `SUPPORTED_LANGUAGES`:

```ts
export const LANGUAGE_PLACEHOLDERS: Record<string, string> = {
  English: 'Ask what is nearby, where to go next, or where to find amenities.',
  Español: 'Pregunta qué hay cerca, a dónde ir o dónde encontrar servicios.',
  Français: 'Demandez ce qui est proche, où aller ou où trouver des équipements.',
  Deutsch: 'Fragen Sie, was in der Nähe ist, wohin Sie gehen oder wo Sie Einrichtungen finden.',
  Italiano: "Chiedi cosa c'è nelle vicinanze, dove andare o dove trovare i servizi.",
  Português: 'Pergunte o que há por perto, para onde ir ou onde encontrar comodidades.',
  中文: '询问附近有什么、下一步去哪里或在哪里可以找到设施。',
  日本語: '近くに何があるか、次にどこへ行くか、設備はどこにあるかを聞いてください。',
  한국어: '주변에 무엇이 있는지, 다음에 어디로 갈지, 편의시설은 어디에 있는지 물어보세요.',
  العربية: 'اسأل عما هو قريب منك، وأين تذهب، وأين تجد المرافق.',
}
```

#### 2b. Restyle the component as a pill button

Replace the entire `return` block inside `LanguagePicker` with this version that wraps the content in a visible pill:

```tsx
return (
  <div className="inline-flex items-center gap-1.5 rounded-full border border-pf-light bg-pf-white px-3 py-1.5 shadow-sm">
    <Globe className="h-3.5 w-3.5 flex-shrink-0 text-pf-deep/50" aria-hidden="true" />
    <select
      value={value}
      onChange={handleChange}
      className="cursor-pointer appearance-none border-none bg-transparent text-xs font-medium text-pf-deep/70 outline-none transition hover:text-pf-deep focus:text-pf-deep"
      aria-label="Select language"
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <option key={lang.code} value={lang.label}>
          {lang.label}
        </option>
      ))}
    </select>
    <svg
      className="h-3 w-3 flex-shrink-0 text-pf-deep/40"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  </div>
)
```

Note: the `accentColor` prop is no longer used in the select style — remove it from the `LanguagePickerProps` type and the function signature if it is no longer referenced anywhere else in the file.

---

### 3. `apps/web/components/ChatWindow.tsx` — accept a `placeholder` prop

#### 3a. Add `placeholder` to `ChatWindowProps`

```ts
type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  isLoading: boolean
  errorMessage?: string | null
  accentColor?: string
  placeholder?: string // add this
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
}
```

#### 3b. Destructure and use it

Add `placeholder` to the destructured props in the function signature:

```ts
export function ChatWindow({
  messages,
  onSend,
  isLoading,
  errorMessage = null,
  accentColor,
  placeholder = 'Ask what is nearby, where to go next, or where to find amenities.',
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
}: ChatWindowProps) {
```

Then find the `<textarea>` element and replace its hardcoded `placeholder` attribute:

```tsx
// Before:
placeholder = 'Ask what is nearby, where to go next, or where to find amenities.'

// After:
placeholder = { placeholder }
```

---

### 4. `apps/web/app/[venueSlug]/chat/page.tsx` — wire up chips hiding and placeholder

#### 4a. Add import

Add `LANGUAGE_PLACEHOLDERS` to the existing `LanguagePicker` import:

```tsx
import {
  getStoredLanguage,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from '../../../components/LanguagePicker'
```

#### 4b. Derive the current placeholder from language state

Add this derived constant inside `VenueChatPage`, after the `language` state declaration:

```ts
const chatPlaceholder =
  LANGUAGE_PLACEHOLDERS[language] ??
  'Ask what is nearby, where to go next, or where to find amenities.'
```

#### 4c. Hide chips for non-English languages

Find this condition that wraps the quick-prompt chips section:

```tsx
{messages.length === 0 ? (
  <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
    <div className="mb-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
      ...
    </div>
    <QuickPromptChips ... />
  </div>
) : null}
```

Change the condition from `messages.length === 0` to:

```tsx
{messages.length === 0 && language === 'English' ? (
```

This hides both the "What can I help you find?" card and the chips whenever a non-English language is active.

#### 4d. Pass `placeholder` to `ChatWindow`

Find the `<ChatWindow ... />` render and add the prop:

```tsx
<ChatWindow
  messages={messages}
  onSend={(message) => { void handleSend(message) }}
  isLoading={isSending}
  errorMessage={sendError}
  accentColor={accent}
  placeholder={chatPlaceholder}
  onPlaceCardView={...}
  onPlaceCardClick={...}
  onDirectionsClick={...}
/>
```

---

## What NOT to do

- Do not translate the quick-prompt chip text — hiding the chips entirely for non-English is the correct behaviour.
- Do not add any server calls or tRPC mutations for these changes. Everything is pure client-side UI state.
- Do not remove the `language` state or the `localStorage` persistence — those were built in the previous sprint and must be preserved.
- Do not add a new dependency for the chevron icon — use the inline SVG provided above (same pattern already used elsewhere in the chat page).

---

## Acceptance criteria

1. The venue category tag ("PARK", "ZOO", etc.) no longer appears in the chat header.
2. The language picker renders as a rounded pill with a border, globe icon, language name, and a small chevron — visually obvious as a clickable control.
3. When "English" is selected (default), the quick-prompt chips and the "What can I help you find?" card are visible and the textarea shows the English placeholder.
4. When any non-English language is selected, the chips and "What can I help you find?" card are hidden and the textarea placeholder updates immediately to the translated version.
5. Switching back to "English" restores the chips and English placeholder.
6. `turbo run typecheck` passes with zero errors.
7. `turbo run lint` passes with zero errors.
