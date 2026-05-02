# Codex Implementation Packet — Marketing Page Polish

## What to build

Three additions to the public marketing site (`apps/web`):

1. **Benefits row** — a strip of 3 concrete outcome stats between the hero and the "How it works" section on `apps/web/app/page.tsx`.
2. **Footer** — a simple site footer at the bottom of `apps/web/app/page.tsx` with copyright, contact email, and a privacy policy placeholder.
3. **OG / social meta tags** — expand the `metadata` export in `apps/web/app/layout.tsx` so link previews look professional when pasted in email or LinkedIn.

---

## Context you must read before writing any code

- `CLAUDE.md` — project engineering constitution
- `apps/web/app/page.tsx` — the marketing page where the benefits row and footer go
- `apps/web/app/layout.tsx` — where the `metadata` export lives

---

## Exact file changes required

### 1. `apps/web/app/layout.tsx` — OG meta tags

Replace the existing `metadata` export with this expanded version:

```ts
export const metadata: Metadata = {
  metadataBase: new URL('https://sweet-luck-production-0037.up.railway.app'),
  title: 'PathFinder — The AI guide built for your venue',
  description:
    'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
  openGraph: {
    title: 'PathFinder — The AI guide built for your venue',
    description:
      'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    url: 'https://sweet-luck-production-0037.up.railway.app',
    siteName: 'PathFinder',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'PathFinder — The AI guide built for your venue',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PathFinder — The AI guide built for your venue',
    description:
      'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    images: ['/og-image.png'],
  },
}
```

**Important:** The `/og-image.png` file does not need to exist right now — Next.js will simply skip the image tag if the file is missing. A real OG image can be added later.

No other changes to `layout.tsx`.

---

### 2. `apps/web/app/page.tsx` — benefits row

#### 2a. Add the benefits data array near the top of the file, alongside `exampleQuestions` and `venueTypes`:

```ts
const benefits = [
  {
    stat: '< 1 afternoon',
    label: 'Average setup time from signup to live QR code',
  },
  {
    stat: '24 / 7',
    label: 'Always on — no shift changes, no hold times, no missed questions',
  },
  {
    stat: 'Zero downloads',
    label: 'Guests scan and chat instantly — no app, no login, no friction',
  },
]
```

#### 2b. Insert the benefits section into the JSX

Place it between the closing `</section>` of the hero (the dark gradient section that ends around line 125) and the opening `<section id="how-it-works" ...>` tag. The new section goes in that gap:

```tsx
<section className="border-b border-pf-light bg-pf-white px-6 py-16 lg:px-10">
  <div className="mx-auto max-w-7xl">
    <div className="grid gap-8 sm:grid-cols-3">
      {benefits.map((b) => (
        <div key={b.stat} className="flex flex-col gap-2">
          <span className="text-4xl font-semibold tracking-tight text-pf-primary">{b.stat}</span>
          <p className="text-sm leading-6 text-pf-deep/60">{b.label}</p>
        </div>
      ))}
    </div>
  </div>
</section>
```

No `FadeIn` wrapper needed here — this section is above the fold and should render immediately.

---

### 3. `apps/web/app/page.tsx` — footer

Replace the closing `</div>` of the outermost wrapper (the very last line before the final `}`) with a footer inserted just before it. The outermost wrapper is `<div className="min-h-screen bg-pf-surface font-jakarta text-pf-deep">`. The footer goes as the last child inside that div, after the dark CTA section:

```tsx
<footer className="border-t border-pf-light bg-pf-white px-6 py-10 lg:px-10">
  <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
    <p className="text-xs text-pf-deep/40">
      © {new Date().getFullYear()} PathFinder. All rights reserved.
    </p>
    <div className="flex items-center gap-6">
      <a
        href="mailto:tomschoenekase@gmail.com"
        className="text-xs text-pf-deep/40 transition hover:text-pf-primary"
      >
        Contact
      </a>
      <a href="/privacy" className="text-xs text-pf-deep/40 transition hover:text-pf-primary">
        Privacy Policy
      </a>
    </div>
  </div>
</footer>
```

The `/privacy` link will show a 404 for now — that is acceptable. Add the actual privacy policy page later.

---

## What NOT to do

- Do not create a `/privacy` page as part of this task. The link can 404 for now.
- Do not create an `og-image.png` file as part of this task. The OG image can be added later without a code change.
- Do not wrap the benefits section in `FadeIn` — it is above the fold and animating it would delay visible content.
- Do not add any new npm dependencies. Everything here uses existing Tailwind classes and the Next.js `Metadata` type already imported in `layout.tsx`.
- Do not change anything in `apps/dashboard` or `apps/admin`. These changes are `apps/web` only.

---

## Acceptance criteria

1. Pasting the site URL into a LinkedIn message or iMessage shows a rich preview with title "PathFinder — The AI guide built for your venue" and the description. (Verify with [opengraph.xyz](https://www.opengraph.xyz) after deploy.)
2. The benefits row appears between the hero and the "How it works" section showing three stats on desktop (3-column grid) and stacked on mobile.
3. A footer appears at the bottom of every page on `apps/web` with copyright year, Contact link, and Privacy Policy link.
4. `turbo run typecheck` passes with zero errors.
5. `turbo run lint` passes with zero errors.
