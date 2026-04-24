# PathFinderOS UI Redesign — Codex Deliverables Plan

> **How to use this document**  
> Each phase is a self-contained unit of work. Execute them in order — Phase 1 must ship before any other phase runs because every subsequent phase depends on the design tokens and font it establishes. Each phase lists exact files, exact changes, exact class values, and exact design decisions. Do not deviate from the brand palette or font defined in Phase 1.

---

## Brand Reference (read before every phase)

### Color Palette

| Token name   | Hex       | Role                                       |
| ------------ | --------- | ------------------------------------------ |
| `pf-deep`    | `#0F2A4A` | Shadows, deepest backgrounds, sidebar      |
| `pf-primary` | `#1F4E8C` | Main brand blue, primary buttons           |
| `pf-accent`  | `#3A7BD5` | Interactive highlights, links, chart lines |
| `pf-light`   | `#C9D4E3` | Borders, metallic tones, soft backgrounds  |
| `pf-surface` | `#F2F5F9` | Page backgrounds (cool neutral light gray) |
| `pf-white`   | `#FFFFFF` | Cards, inputs, clean panels                |

Accent gradient (for hero elements only): `linear-gradient(135deg, #1F4E8C 0%, #3A7BD5 100%)`

### Typography

**Font**: Plus Jakarta Sans, loaded via `next/font/google`. This is a humanist sans-serif — warm, grounded, and not used by major tech brands. It has strong personality without being quirky.

- Display / hero headline: `font-light text-6xl` or larger, long tracking
- Section headlines: `font-semibold text-3xl`
- Body: `font-normal text-base` or `text-sm` for supporting text
- Labels / caps: `font-semibold text-xs uppercase tracking-widest`

### Shape Language

- All cards, panels, and interactive surfaces: `rounded-3xl` (keep the very rounded aesthetic)
- Buttons: `rounded-full`
- Chips and tags: `rounded-full`
- Input fields: `rounded-2xl`
- Inner panels within cards: `rounded-2xl`

### Tone

This product should feel like REI, YETI, or Eddie Bauer — credible, human, outdoors-professional. Not AI-forward. Not a generic SaaS tool. Every word in placeholder copy should reinforce that this is a platform built for real people managing real venues.

### Logo Assets

Both logo files are in `/AssetsFiles/`. Each phase that uses a logo will specify exactly where to place the asset and how to reference it.

- `PathfinderLogo.svg` — full wordmark with the compass swirl + "PathFinder" text
- `PathfinderSmallLogo.svg` — compass swirl only (no text), used as favicon/icon in tight spaces

---

## Phase 1 — Design System Foundation

> **Scope**: No visible UI changes yet. This phase only establishes the font, color tokens, and Tailwind config that every subsequent phase draws from.  
> **Files changed**: `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/dashboard/app/layout.tsx`, `apps/dashboard/app/globals.css`, `apps/admin/app/layout.tsx`, `apps/admin/app/globals.css`, `tailwind.config.ts` in all three apps, both public/ asset folders.

### 1A — Copy Logo Files to Public Directories

Copy the following files:

- `AssetsFiles/PathfinderLogo.svg` → `apps/web/public/pathfinder-logo.svg`
- `AssetsFiles/PathfinderSmallLogo.svg` → `apps/web/public/pathfinder-icon.svg`
- `AssetsFiles/PathfinderLogo.svg` → `apps/dashboard/public/pathfinder-logo.svg`
- `AssetsFiles/PathfinderSmallLogo.svg` → `apps/dashboard/public/pathfinder-icon.svg`
- `AssetsFiles/PathfinderLogo.svg` → `apps/admin/public/pathfinder-logo.svg`
- `AssetsFiles/PathfinderSmallLogo.svg` → `apps/admin/public/pathfinder-icon.svg`

### 1B — Font Setup in `apps/web/app/layout.tsx`

Replace the existing layout with:

```tsx
import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Plus_Jakarta_Sans } from 'next/font/google'

import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'PathFinder',
  description: 'The AI guide built for your venue.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={jakarta.variable}>
      <head>
        <meta name="theme-color" content="#1F4E8C" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body className="font-jakarta antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); }",
          }}
        />
      </body>
    </html>
  )
}
```

Note: `apple-mobile-web-app-status-bar-style` changes from `black-translucent` to `default` because the chat is now light-mode.

### 1C — Font Setup in `apps/dashboard/app/layout.tsx`

Apply the same `Plus_Jakarta_Sans` import and `className={jakarta.variable}` pattern. Add `font-jakarta antialiased` to `<body>`.

### 1D — Font Setup in `apps/admin/app/layout.tsx`

Same as 1C.

### 1E — Global CSS for `apps/web/app/globals.css`

Replace or merge the existing globals with:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --pf-deep: #0f2a4a;
  --pf-primary: #1f4e8c;
  --pf-accent: #3a7bd5;
  --pf-light: #c9d4e3;
  --pf-surface: #f2f5f9;
  --pf-white: #ffffff;
}

@layer base {
  body {
    background-color: var(--pf-surface);
    color: var(--pf-deep);
  }
}

/* Scroll-reveal animation classes (used by the FadeIn wrapper in Phase 2) */
@layer utilities {
  .reveal {
    opacity: 0;
    transform: translateY(20px);
    transition:
      opacity 0.5s ease,
      transform 0.5s ease;
  }
  .reveal.visible {
    opacity: 1;
    transform: translateY(0);
  }
}
```

Apply the same global CSS to `apps/dashboard/app/globals.css` and `apps/admin/app/globals.css`.

### 1F — Tailwind Config Extension in All Three Apps

In each app's `tailwind.config.ts`, extend the theme:

```ts
theme: {
  extend: {
    fontFamily: {
      jakarta: ['var(--font-jakarta)', 'sans-serif'],
    },
    colors: {
      pf: {
        deep: '#0F2A4A',
        primary: '#1F4E8C',
        accent: '#3A7BD5',
        light: '#C9D4E3',
        surface: '#F2F5F9',
        white: '#FFFFFF',
      },
    },
  },
},
```

### 1G — Create FadeIn Wrapper Component

Create `apps/web/components/FadeIn.tsx`:

```tsx
'use client'

import { useEffect, useRef, type ReactNode } from 'react'

export function FadeIn({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          el.style.transitionDelay = `${delay}ms`
          el.classList.add('visible')
          observer.disconnect()
        }
      },
      { threshold: 0.1 },
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [delay])

  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  )
}
```

Create the same component at `apps/dashboard/components/FadeIn.tsx` (same code, different path).

---

## Phase 2 — Marketing Page

> **Scope**: Full rewrite of `apps/web/app/page.tsx`. This is the page venue operators and prospects land on. Goal: warm, credible, human. Not AI-forward.  
> **Files changed**: `apps/web/app/page.tsx`

### Design Intent

- Light page (`pf-surface` background) with one deep-dark hero section using the brand gradient
- Hero image area: since no real photo is available yet, render a styled placeholder div with the brand gradient. When a real photo is available, it replaces this div with a `next/image` as the background.
- The word "AI" should appear sparingly — prefer "your venue guide," "your guest assistant," "answers that sound like your staff"
- Navigation bar at top: PathFinder logo (full wordmark SVG), one CTA button
- Sections in order: Hero → How it works → What guests can ask → Who it's for → CTA band
- Scroll animations on all sections below the hero using `FadeIn`

### Implementation

Replace `apps/web/app/page.tsx` entirely with:

```tsx
import Image from 'next/image'
import {
  Binoculars,
  Building2,
  Fish,
  Landmark,
  Leaf,
  MapPinned,
  ScanLine,
  Trophy,
} from 'lucide-react'

import { FadeIn } from '../components/FadeIn'

const exampleQuestions = [
  "Where's the closest bathroom?",
  "What's good for kids under 5?",
  'How far is the elephant exhibit?',
  'What time does the cafe close?',
  'Is there seating near the entrance?',
  "What's the featured exhibit today?",
]

const venueTypes = [
  { label: 'Zoos & Aquariums', icon: Fish },
  { label: 'Museums & Galleries', icon: Landmark },
  { label: 'Malls & Retail Centers', icon: Building2 },
  { label: 'Sports Venues & Stadiums', icon: Trophy },
  { label: 'Parks & Botanical Gardens', icon: Leaf },
]

export default function WebHomePage() {
  return (
    <div className="min-h-screen bg-pf-surface font-jakarta text-pf-deep">
      {/* ── Nav ───────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-pf-light/60 bg-pf-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <Image src="/pathfinder-logo.svg" alt="PathFinder" width={140} height={36} priority />
          <a
            href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
            className="inline-flex min-h-10 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent"
          >
            Request a demo
          </a>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden bg-pf-deep text-white">
        {/* Gradient background — replace this div with next/image when a real photo is available */}
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(135deg, #0F2A4A 0%, #1F4E8C 60%, #3A7BD5 100%)' }}
          aria-hidden="true"
        />
        {/* Subtle texture overlay */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: 'radial-gradient(circle at 70% 30%, #C9D4E3 0%, transparent 60%)',
          }}
          aria-hidden="true"
        />

        <div className="relative mx-auto grid max-w-7xl gap-12 px-6 py-24 lg:grid-cols-[1fr_0.85fr] lg:items-center lg:px-10 lg:py-32">
          <div>
            <span className="inline-flex rounded-full border border-pf-light/30 bg-pf-light/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-pf-light">
              PathFinder
            </span>
            <h1 className="mt-6 text-5xl font-light leading-[1.1] tracking-tight sm:text-6xl lg:text-7xl">
              Your venue guide,
              <br />
              <span className="font-semibold text-pf-light">built on your places.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-pf-light/80">
              Guests ask questions. PathFinder answers — with real directions, hours, and
              recommendations specific to your venue. Set up in an afternoon. No app download
              required.
            </p>
            <div className="mt-10 flex flex-col gap-4 sm:flex-row">
              <a
                href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
                className="inline-flex min-h-12 items-center justify-center rounded-full bg-pf-accent px-7 text-sm font-semibold text-white transition hover:bg-[#4d8de0]"
              >
                Request a demo
              </a>
              <a
                href="#how-it-works"
                className="inline-flex min-h-12 items-center justify-center rounded-full border border-pf-light/30 px-7 text-sm font-semibold text-pf-light transition hover:border-pf-light hover:bg-pf-light/10"
              >
                See how it works
              </a>
            </div>
          </div>

          {/* Static chat mockup — replace inner image with a real app screenshot when available */}
          <div className="rounded-3xl border border-pf-light/20 bg-pf-white/8 p-4 shadow-2xl backdrop-blur">
            <div className="rounded-2xl bg-pf-deep/80 p-5">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-pf-accent">
                  <MapPinned className="h-5 w-5 text-white" aria-hidden="true" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-white">Riverside Zoo Guide</p>
                  <p className="text-xs text-pf-light/60">Powered by PathFinder</p>
                </div>
              </div>
              <div className="mt-5 space-y-4">
                <div className="ml-auto max-w-[80%] rounded-3xl rounded-br-md bg-pf-accent px-4 py-3 text-sm font-medium text-white">
                  What should we see first with two kids?
                </div>
                <div className="max-w-[88%] rounded-3xl rounded-bl-md bg-pf-white px-4 py-3 text-sm leading-6 text-pf-deep">
                  Start at River Otters — it opens at 9 AM and draws the biggest crowds by noon.
                  From there, the east path takes you to the touch pool in about 4 minutes.
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
                  <div className="rounded-2xl border border-pf-light/20 bg-pf-light/10 p-3 text-pf-light">
                    <MapPinned className="mb-2 h-4 w-4" aria-hidden="true" />
                    Directions-aware
                  </div>
                  <div className="rounded-2xl border border-pf-light/20 bg-pf-light/10 p-3 text-pf-light">
                    <ScanLine className="mb-2 h-4 w-4" aria-hidden="true" />
                    No app download
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────── */}
      <section id="how-it-works" className="px-6 py-24 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <FadeIn>
            <span className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              How it works
            </span>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-snug tracking-tight sm:text-4xl">
              Up and running before your guests arrive.
            </h2>
          </FadeIn>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Add your places',
                body: "Enter your venue's locations, exhibits, amenities, and hours. The more detail you add, the better your guide gets.",
              },
              {
                step: '02',
                title: 'The guide learns your venue',
                body: 'PathFinder builds a guide that knows your specific layout — not generic directions.',
              },
              {
                step: '03',
                title: 'Guests get instant answers',
                body: 'Via QR code or link, on any phone, no app download required. It just works.',
              },
            ].map((item, index) => (
              <FadeIn key={item.step} delay={index * 100}>
                <article className="rounded-3xl border border-pf-light bg-pf-white p-7 shadow-sm">
                  <span className="text-4xl font-light text-pf-light">{item.step}</span>
                  <h3 className="mt-5 text-xl font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-pf-deep/60">{item.body}</p>
                </article>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── What guests can ask ───────────────────────────────────── */}
      <section className="bg-pf-white px-6 py-24 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <FadeIn>
            <span className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              What guests ask
            </span>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-snug tracking-tight sm:text-4xl">
              Answers that sound like your best floor staff.
            </h2>
          </FadeIn>

          <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {exampleQuestions.map((question, index) => (
              <FadeIn key={question} delay={index * 80}>
                <div
                  className={`rounded-3xl px-6 py-5 text-sm font-medium leading-6 ${
                    index % 3 === 0
                      ? 'bg-pf-deep text-pf-light'
                      : index % 3 === 1
                        ? 'border border-pf-light bg-pf-surface text-pf-deep'
                        : 'border border-pf-accent/30 bg-pf-accent/5 text-pf-primary'
                  }`}
                >
                  &ldquo;{question}&rdquo;
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Who it's for ─────────────────────────────────────────── */}
      <section className="px-6 py-24 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <FadeIn>
            <span className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Who it&apos;s for
            </span>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-snug tracking-tight sm:text-4xl">
              Built for venues that host crowds.
            </h2>
          </FadeIn>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {venueTypes.map(({ label, icon: Icon }, index) => (
              <FadeIn key={label} delay={index * 80}>
                <article className="rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm transition hover:border-pf-accent/40 hover:shadow-md">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-surface">
                    <Icon className="h-5 w-5 text-pf-primary" aria-hidden="true" />
                  </div>
                  <h3 className="mt-5 text-base font-semibold leading-6">{label}</h3>
                </article>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA band ─────────────────────────────────────────────── */}
      <section className="bg-pf-primary px-6 py-24 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <FadeIn>
            <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <Binoculars className="h-8 w-8 text-pf-light" aria-hidden="true" />
                <h2 className="mt-5 max-w-xl text-3xl font-semibold leading-snug tracking-tight text-white sm:text-4xl">
                  Ready to give your guests a smarter experience?
                </h2>
                <p className="mt-4 max-w-lg text-base leading-7 text-pf-light/80">
                  Set up takes an afternoon. Your guests notice immediately.
                </p>
              </div>
              <a
                href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
                className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-full bg-pf-white px-7 text-sm font-semibold text-pf-primary transition hover:bg-pf-light"
              >
                Get in touch
              </a>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer className="border-t border-pf-light bg-pf-surface px-6 py-10 lg:px-10">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6">
          <Image src="/pathfinder-logo.svg" alt="PathFinder" width={120} height={30} />
          <p className="text-xs text-pf-deep/40">
            &copy; {new Date().getFullYear()} PathFinder. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  )
}
```

---

## Phase 3 — Venue Landing Page

> **Scope**: The page a guest sees after scanning a QR code, before entering chat. `apps/web/app/[venueSlug]/page.tsx`. Should feel like arriving at the venue — welcoming, clear, light.  
> **Files changed**: `apps/web/app/[venueSlug]/page.tsx`

Replace the full file. Keep all data-fetching logic (`loadVenue`, `VenueSummary` type, the `VenueLandingPageProps`). Only the JSX returned from `VenueLandingPage` and the not-found state changes.

**Not-found state:**

```tsx
return (
  <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
    <section className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
      <Image src="/pathfinder-icon.svg" alt="" width={48} height={48} className="mx-auto" />
      <h1 className="mt-5 text-2xl font-semibold tracking-tight text-pf-deep">Venue not found</h1>
      <p className="mt-3 text-sm leading-6 text-pf-deep/60">
        We couldn&apos;t find this venue. Check the link and try again.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
      >
        Back to home
      </Link>
    </section>
  </main>
)
```

**Found state:**

```tsx
return (
  <main className="flex min-h-screen items-center justify-center bg-pf-surface px-4 py-12 sm:px-6">
    <section className="w-full max-w-lg">
      {/* Venue card */}
      <div className="rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm sm:p-10">
        <div className="flex flex-wrap items-center gap-3">
          <Image src="/pathfinder-icon.svg" alt="PathFinder" width={32} height={32} />
          {venue.category ? (
            <span className="rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-widest text-pf-primary">
              {venue.category}
            </span>
          ) : null}
        </div>

        <h1 className="mt-5 text-4xl font-light tracking-tight text-pf-deep sm:text-5xl">
          {venue.name}
        </h1>
        <p className="mt-4 text-base leading-7 text-pf-deep/60">
          {venue.description ?? 'Ask your guide where to go, what to see, and what to do next.'}
        </p>

        <div className="mt-8">
          <Link
            href={`/${venueSlug}/chat`}
            className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-pf-primary px-7 text-sm font-semibold text-white transition hover:bg-pf-accent sm:w-auto"
          >
            Open your guide &rarr;
          </Link>
        </div>
      </div>

      {/* Powered by footer */}
      <p className="mt-5 text-center text-xs text-pf-deep/30">
        Powered by{' '}
        <a href="/" className="font-medium text-pf-deep/40 hover:text-pf-primary">
          PathFinder
        </a>
      </p>
    </section>
  </main>
)
```

---

## Phase 4 — Guest Chat Page Structure

> **Scope**: The page guests use during their visit. This is the most important surface. `apps/web/app/[venueSlug]/chat/page.tsx`. Redesign the page shell: header, AI name display, location banner placement, empty state, "Powered by PathFinder" footer.  
> **Files changed**: `apps/web/app/[venueSlug]/chat/page.tsx`

### Design Decisions

- **Light mode throughout** — guests use this outdoors in sunlight; white backgrounds, high contrast text
- **AI name at top**: Display as "{venue.name} Guide" in large type. When a `aiPersonaName` field is added to the venue schema in the future, replace `venue.name + ' Guide'` with `venue.aiPersonaName`. For now use `{venue.name} Guide`.
- **"Powered by PathFinder"**: Small, subtle, at the very bottom of the screen
- **Back link**: Light, above the AI name
- **Layout**: Full viewport height, flex-col, header pinned top, input pinned bottom, messages scroll in the middle

**Loading state** (replace the dark glassmorphism with):

```tsx
<main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
  <div className="flex flex-col items-center gap-5 text-center">
    <Image src="/pathfinder-icon.svg" alt="" width={40} height={40} className="animate-pulse" />
    <p className="text-sm font-medium text-pf-deep/60">Loading your guide...</p>
  </div>
</main>
```

**Error state** (venue not found):

```tsx
<main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
  <div className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm">
    <h1 className="text-2xl font-semibold text-pf-deep">Venue unavailable</h1>
    <p className="mt-3 text-sm leading-6 text-pf-deep/60">
      {pageError ?? 'This venue link is not active.'}
    </p>
    <Link
      href="/"
      className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
    >
      Back to home
    </Link>
  </div>
</main>
```

**Main chat page return** (replace the dark layout):

```tsx
<div className="flex min-h-screen flex-col bg-pf-surface">
  {/* Pinned header */}
  <header className="border-b border-pf-light bg-pf-white px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6">
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
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
        {venue.name} Guide
      </h1>
      {venue.category ? (
        <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-pf-accent">
          {venue.category.toLowerCase().replace(/_/g, ' ')}
        </p>
      ) : null}
    </div>
  </header>

  {/* Location banner (keep existing component, but it gets restyled in Phase 5) */}
  <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
    <LocationBanner permission={permission} onRefresh={refresh} />
  </div>

  {/* Empty state / quick prompts */}
  {messages.length === 0 ? (
    <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
      <div className="mb-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-pf-deep">What can I help you find?</h2>
        <p className="mt-2 text-sm leading-6 text-pf-deep/60">
          {venue.description ??
            'Ask about exhibits, food, restrooms, directions, or anything nearby.'}
        </p>
      </div>
      <QuickPromptChips
        venueName={venue.name}
        venueCategory={venue.category ?? undefined}
        onSend={(prompt) => {
          void handleSend(prompt)
        }}
      />
    </div>
  ) : null}

  {/* Messages — grows to fill remaining space */}
  <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 sm:px-6">
    <ChatWindow
      messages={messages}
      onSend={(message) => {
        void handleSend(message)
      }}
      isLoading={isSending}
      errorMessage={sendError}
      onPlaceCardView={(placeId) => {
        if (viewedPlaceIdsRef.current.has(placeId)) return
        viewedPlaceIdsRef.current.add(placeId)
        trackPlaceEvent('place_card.viewed', placeId)
      }}
      onPlaceCardClick={(placeId) => {
        trackPlaceEvent('place_card.clicked', placeId)
      }}
      onDirectionsClick={(placeId) => {
        trackPlaceEvent('directions.opened', placeId)
      }}
    />
  </div>

  {/* Powered by footer */}
  <div className="pb-[env(safe-area-inset-bottom,1rem)] pt-2 text-center">
    <p className="text-[10px] text-pf-deep/25">
      Powered by{' '}
      <a href="https://pathfinder.app" className="hover:text-pf-primary">
        PathFinder
      </a>
    </p>
  </div>
</div>
```

Keep all hooks, useEffect blocks, event handlers, and analytics calls exactly as they are. Only the JSX structure and classNames change.

---

## Phase 5 — Guest Chat Components

> **Scope**: All components rendered inside the guest chat. Every single one flips from dark glassmorphism to the light brand palette.  
> **Files changed**: `apps/web/components/ChatWindow.tsx`, `apps/web/components/MessageBubble.tsx`, `apps/web/components/PlaceCard.tsx`, `apps/web/components/QuickPromptChips.tsx`, `apps/web/components/TypingIndicator.tsx`, `apps/web/components/LocationBanner.tsx`

### ChatWindow.tsx

Keep all props, state, refs, and scroll logic exactly as-is. Only change the returned JSX.

- Outer `<section>`: `flex flex-1 flex-col overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm`
- Scroll container: `flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5`
- Input bar: `border-t border-pf-light bg-pf-surface p-3 sm:p-4`
- `<textarea>`: `min-h-14 flex-1 resize-none rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-[16px] leading-6 text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20`
- Send button: `inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light disabled:text-pf-deep/30`
- Error banner: `mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700`

### MessageBubble.tsx

```tsx
type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
}

export function MessageBubble({ role, content }: MessageBubbleProps) {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-[1.75rem] px-4 py-3 text-sm leading-6 ${
          isUser
            ? 'bg-pf-primary text-white rounded-br-md'
            : 'border border-pf-light bg-pf-surface text-pf-deep rounded-bl-md'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{content}</p>
      </div>
    </div>
  )
}
```

### PlaceCard.tsx (rich card — bigger photo, more detail, more visual weight)

Redesign as a rich card with a larger photo area, full-width layout, and more detail visible:

```tsx
import { useEffect } from 'react'
import { MapPin, Navigation } from 'lucide-react'

// ... keep PlaceCardProps and formatDistance exactly as-is ...

export function PlaceCard({
  id,
  name,
  type,
  photoUrl,
  distanceMeters,
  lat,
  lng,
  onCardClick,
  onDirectionsClick,
  onView,
}: PlaceCardProps) {
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`

  useEffect(() => {
    onView?.(id)
  }, [id, onView])

  return (
    <div
      className="overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm transition hover:border-pf-accent/40 hover:shadow-md"
      onClick={() => {
        onCardClick?.(id)
      }}
    >
      {/* Photo — tall, full width */}
      {photoUrl ? (
        <div className="h-36 w-full overflow-hidden bg-pf-surface">
          <img src={photoUrl} alt={name} loading="lazy" className="h-full w-full object-cover" />
        </div>
      ) : (
        <div className="flex h-28 w-full items-center justify-center bg-pf-surface">
          <MapPin className="h-8 w-8 text-pf-light" aria-hidden="true" />
        </div>
      )}

      {/* Content */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-semibold text-pf-deep">{name}</p>
            <p className="mt-0.5 text-xs capitalize text-pf-deep/50">
              {type.toLowerCase().replace(/_/g, ' ')}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-pf-surface px-2.5 py-1 text-xs font-semibold text-pf-primary">
            {formatDistance(distanceMeters)}
          </span>
        </div>

        <a
          href={directionsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-full border border-pf-light bg-pf-surface px-4 text-xs font-semibold text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
          onClick={(e) => {
            e.stopPropagation()
            onDirectionsClick?.(id)
          }}
        >
          <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
          Get directions
        </a>
      </div>
    </div>
  )
}
```

Update `ChatWindow.tsx` where it renders place cards: wrap the place cards in a grid: `<div className="mt-3 grid gap-3 sm:grid-cols-2">`.

### QuickPromptChips.tsx

Keep all props and `buildPrompts` logic exactly as-is. Only change the JSX:

```tsx
export function QuickPromptChips({ onSend, venueName, venueCategory }: QuickPromptChipsProps) {
  const prompts = buildPrompts(venueName, venueCategory)

  return (
    <section className="mb-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-pf-deep/40">
        Start with a question
      </p>
      <div className="flex flex-wrap gap-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="inline-flex min-h-10 items-center justify-center rounded-full border border-pf-light bg-pf-white px-4 text-center text-sm font-medium text-pf-primary shadow-sm transition hover:border-pf-accent hover:bg-pf-accent/5"
            type="button"
            onClick={() => {
              onSend(prompt)
            }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}
```

### TypingIndicator.tsx

Read the current file and update it: replace dark bubble with a light `pf-surface` bubble containing three animated `pf-accent`-colored dots.

### LocationBanner.tsx

Keep all props and logic. Update only the classNames:

- Loading state: `rounded-3xl border border-pf-light bg-pf-white p-4 text-pf-deep/60 shadow-sm`
- Prompt/denied state: `rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm`
- Title: `text-sm font-semibold text-pf-deep`
- Description: `mt-1 text-sm leading-6 text-pf-deep/60`
- Button: `inline-flex min-h-10 items-center justify-center rounded-full border border-amber-300 bg-pf-white px-4 text-sm font-medium text-amber-700 transition hover:bg-amber-50`

---

## Phase 6 — Dashboard Shell & Navigation

> **Scope**: The persistent sidebar and layout shell. `apps/dashboard/components/DashboardShell.tsx`. Keep dark sidebar (as specified), but replace the generic slate-950 with brand `pf-deep`, replace cyan accents with `pf-accent`, and add the PathFinder small logo.  
> **Files changed**: `apps/dashboard/components/DashboardShell.tsx`

### Changes

- Sidebar background: `bg-pf-deep` (was `bg-slate-950`)
- Sidebar border: `border-pf-primary/30` (was `border-slate-800`)
- Header separator: `border-pf-primary/20`
- "PathFinder" label above org name: replace the `<p>` text with `<img src="/pathfinder-logo.svg" alt="PathFinder" className="h-7 w-auto" />` using a standard `<img>` tag (not next/image — sidebar is a client component with dynamic import)
- Active nav item: replace `border-l-2 border-cyan-400 bg-slate-800 text-white` with `border-l-2 border-pf-accent bg-pf-primary/20 text-white`
- Inactive nav item: replace `text-slate-300 hover:bg-slate-900 hover:text-white` with `text-pf-light/70 hover:bg-pf-primary/10 hover:text-white`
- Sign out button: `border-pf-primary/30 text-pf-light/70 hover:border-pf-primary hover:bg-pf-primary/10 hover:text-white`
- Main content area: `bg-pf-surface` (was `bg-slate-100`)
- Org name: `text-pf-white` (same as current)
- "Tenant dashboard" subtitle: `text-pf-light/50`

---

## Phase 7 — Dashboard Overview Page

> **Scope**: `apps/dashboard/components/DashboardOverview.tsx`. This is the homepage of the dashboard. Keep the four stat cards and the quick actions section. Update all colors and fonts.  
> **Files changed**: `apps/dashboard/components/DashboardOverview.tsx`

### Stat Cards

Replace `border-slate-200 bg-white hover:border-cyan-200` with `border-pf-light bg-pf-white hover:border-pf-accent/40 hover:shadow-md`.

Replace the icon color `text-slate-400` with `text-pf-accent`.

The active alerts icon stays amber: `text-amber-500` — this is intentional signaling.

Stat number: replace `text-slate-950` with `text-pf-deep`.

### Quick Actions Section

Container: `rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm`.

The `Sparkles` icon: `text-pf-accent`.

Action cards: `rounded-3xl border border-pf-light bg-pf-surface p-5 transition hover:border-pf-accent/40 hover:bg-pf-white`.

Action icon container: `flex h-11 w-11 items-center justify-center rounded-2xl bg-pf-white text-pf-primary shadow-sm`.

Page heading: `text-3xl font-semibold tracking-tight text-pf-deep`.

Supporting text: `text-sm leading-6 text-pf-deep/50`.

---

## Phase 8 — Dashboard Venues Pages

> **Scope**: The venues list page, venue card, and venue detail page.  
> **Files changed**: `apps/dashboard/app/(app)/venues/page.tsx`, `apps/dashboard/components/VenueCard.tsx`, `apps/dashboard/app/(app)/venues/[venueId]/page.tsx`, `apps/dashboard/app/(app)/venues/new/page.tsx`, `apps/dashboard/app/(app)/venues/[venueId]/edit/page.tsx`

### `apps/dashboard/app/(app)/venues/page.tsx`

- Page background: `bg-pf-surface`
- `"Dashboard"` eyebrow label: `text-xs font-semibold uppercase tracking-widest text-pf-accent` (was `text-cyan-700`)
- Page heading: `text-4xl font-semibold tracking-tight text-pf-deep`
- "New venue" button: `inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent`
- Empty state: `rounded-3xl border border-dashed border-pf-light bg-pf-white p-10 text-center shadow-sm`

### `apps/dashboard/components/VenueCard.tsx`

- Card container: `block rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm transition hover:border-pf-accent/40 hover:shadow-md`
- Category eyebrow: `text-xs font-semibold uppercase tracking-widest text-pf-accent`
- Venue name: `text-2xl font-semibold tracking-tight text-pf-deep`
- Description: `text-sm leading-6 text-pf-deep/60`
- Active badge: `rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700` (keep — intentional status color)
- Inactive badge: `rounded-full bg-pf-surface px-3 py-1 text-xs font-semibold text-pf-deep/40`
- DT labels: `text-xs uppercase tracking-widest text-pf-deep/30`
- DD values: `mt-1 font-medium text-pf-deep`

### Venue detail page (`apps/dashboard/app/(app)/venues/[venueId]/page.tsx`)

Read this file first, then apply the same palette replacement:

- All `cyan-*` → `pf-accent` or `pf-primary`
- All `slate-950` → `pf-deep`
- All `slate-200` borders → `pf-light`
- All `bg-white` → `bg-pf-white`
- All `bg-slate-50` → `bg-pf-surface`

---

## Phase 9 — Dashboard Analytics Page

> **Scope**: `apps/dashboard/app/(app)/analytics/page.tsx`. The most visually complex dashboard page. Update all colors, update chart line and dot colors, and update insight card colors.  
> **Files changed**: `apps/dashboard/app/(app)/analytics/page.tsx`

### Color Updates

- Page background: `bg-pf-surface` (was `bg-slate-50`)
- All section cards: `rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm`
- All eyebrow labels: `text-xs font-semibold uppercase tracking-widest text-pf-accent` (was `text-cyan-700`)
- All section headings: `text-pf-deep`
- All body text: `text-pf-deep/60`

### SVG Chart Colors

In `SessionTrendChart`:

- Polyline stroke: change `stroke="#0891b2"` → `stroke="#3A7BD5"` (pf-accent)
- Dot fill: change `fill="#0f172a"` → `fill="#1F4E8C"` (pf-primary)
- Grid lines: change `stroke="#e2e8f0"` → `stroke="#C9D4E3"` (pf-light)
- Bottom grid line: change `stroke="#cbd5e1"` → `stroke="#C9D4E3"`

### SessionTrendChart Stat Box

Replace `rounded-[1.25rem] bg-slate-950 px-4 py-3 text-white` with `rounded-2xl bg-pf-primary px-4 py-3 text-white`. Replace the "30 day total" label: `text-pf-light/60`.

### Insight Cards

Keep the semantic colors (sky, rose, emerald, amber) — these communicate meaning and should not change.

### "Viewing" badge on digest list

Replace `bg-cyan-500` with `bg-pf-accent`.

### Top Questions list

Replace `text-cyan-700` rank numbers with `text-pf-accent`.

---

## Phase 10 — Dashboard AI Controls Page

> **Scope**: `apps/dashboard/app/(app)/ai-controls/page.tsx` and `apps/dashboard/components/AiControlsForm.tsx`.  
> **Files changed**: Both files listed above.

### `apps/dashboard/app/(app)/ai-controls/page.tsx`

The dark hero banner at the top currently uses `bg-slate-950` with `text-cyan-300` accent. Replace:

- Banner background: `bg-pf-deep`
- Eyebrow text: `text-pf-light text-xs font-semibold uppercase tracking-widest`
- Heading: `text-white`
- Body: `text-pf-light/70`

Empty state: apply standard `border-pf-light bg-pf-white` card pattern.

### `apps/dashboard/components/AiControlsForm.tsx`

Read the full file first, then:

- All `cyan-*` focus rings → `focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20`
- All `border-slate-300` inputs → `border-pf-light`
- All form section headings → `text-pf-deep`
- Primary save button → `bg-pf-primary hover:bg-pf-accent text-white rounded-full`
- Toggle/switch accent (if any) → `pf-accent`

---

## Phase 11 — Dashboard Operational Updates

> **Scope**: The operational updates list and form.  
> **Files changed**: `apps/dashboard/app/(app)/operational-updates/page.tsx`, `apps/dashboard/app/(app)/operational-updates/new/page.tsx`, `apps/dashboard/components/OperationalUpdatesList.tsx`, `apps/dashboard/components/OperationalUpdateForm.tsx`

Read each file before editing. Apply the standard palette replacement across all of them:

- All `cyan-*` → `pf-accent` for decorative use, `pf-primary` for CTAs
- All `slate-950` text → `pf-deep`
- All `slate-200` borders → `pf-light`
- All `bg-slate-50` → `bg-pf-surface`
- All `bg-white` → `bg-pf-white`
- All section eyebrow labels → `text-xs font-semibold uppercase tracking-widest text-pf-accent`

Severity indicators (these carry semantic meaning — keep the colors intentional):

- `CRITICAL`: keep `rose-*` / red
- `WARNING`: keep `amber-*`
- `INFO`: use `pf-accent` (replacing `cyan-*` for info)

All input focus states: `focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20`

---

## Phase 12 — Dashboard Forms (Venue, Place)

> **Scope**: `apps/dashboard/components/VenueForm.tsx`, `apps/dashboard/components/PlaceForm.tsx`, `apps/dashboard/components/PlaceRow.tsx`  
> **Files changed**: All three files listed.

Read each file fully before editing. Apply the same universal replacements:

- Input border: `border-pf-light` (not `border-slate-300`)
- Input focus: `focus:border-pf-accent focus:ring-pf-accent/20`
- Input text: `text-pf-deep`
- Label text: `text-sm font-medium text-pf-deep/70`
- Helper text: `text-xs text-pf-deep/40`
- Error text: keep `text-rose-600`
- CopyUrlButton (in `CopyUrlButton.tsx`) — replace `cyan-*` with `pf-accent`

---

## Phase 13 — Dashboard Onboarding

> **Scope**: The org picker page and the multi-step setup wizard.  
> **Files changed**: `apps/dashboard/app/onboarding/page.tsx`, `apps/dashboard/app/(app)/onboarding/setup/page.tsx`

### Org Picker (`apps/dashboard/app/onboarding/page.tsx`)

- Background: `bg-pf-surface`
- Heading: `text-2xl font-semibold text-pf-deep`
- Supporting text: `text-pf-deep/60`
- Sign out link: `text-pf-deep/30 hover:text-pf-primary`

The Clerk `OrganizationList` and `CreateOrganization` components render Clerk's own UI — do not try to restyle them. Wrap them in a clean white card: `rounded-3xl border border-pf-light bg-pf-white p-8 shadow-sm`.

### Setup Wizard (`apps/dashboard/app/(app)/onboarding/setup/page.tsx`)

- Page background: `bg-pf-surface`
- Hero banner (currently `bg-slate-950`): change to `bg-pf-deep`
- Eyebrow: `text-pf-light text-xs font-semibold uppercase tracking-widest`
- Main form card: `rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm`

**StepIndicator**:

- Active/complete step circle: `border-pf-accent bg-pf-accent text-white` (was `border-cyan-300 bg-cyan-300 text-slate-950`)
- Active step label: `font-semibold text-white`
- Complete step label: `text-pf-light`
- Connector line: `bg-pf-primary/30`

**Form inputs** (VenueBasicsStep, VenueLocationStep, FirstPlaceStep):

- All inputs and selects: `border-pf-light focus:border-pf-accent focus:ring-pf-accent/20`
- Back button: `border-pf-light text-pf-deep/70 hover:bg-pf-surface`
- Continue/submit button: `bg-pf-primary text-white hover:bg-pf-accent rounded-full`

**Completion state**:

- Card: `rounded-3xl border border-emerald-200 bg-pf-white p-8 text-center shadow-sm`
- Icon circle: `bg-emerald-100 text-emerald-700` (keep — semantic success color)
- Heading: `text-3xl font-semibold tracking-tight text-pf-deep`
- "Taking you to your dashboard..." text: `text-emerald-700 font-medium`

---

## Phase 14 — Dashboard Auth Pages

> **Scope**: `apps/dashboard/app/(auth)/sign-in/[[...sign-in]]/page.tsx` and `apps/dashboard/app/(auth)/sign-up/[[...sign-up]]/page.tsx`  
> **Files changed**: Both pages listed.

Read both files. The Clerk `<SignIn>` and `<SignUp>` components render their own UI — do not try to restyle them. The page surrounding them gets restyled:

- Page background: `min-h-screen bg-pf-surface flex items-center justify-center px-6 py-12`
- Above the Clerk component, add the PathFinder logo:
  ```tsx
  <div className="mb-8 text-center">
    <img src="/pathfinder-logo.svg" alt="PathFinder" className="mx-auto h-8 w-auto" />
  </div>
  ```
- Wrap everything in a clean centered column: `flex flex-col items-center`

---

## Phase 15 — Web App Not-Found and Error Pages

> **Scope**: `apps/web/app/not-found.tsx`  
> **Files changed**: `apps/web/app/not-found.tsx`

Read the current file. Apply the light palette:

- Background: `bg-pf-surface`
- Card: `rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm`
- Add PathFinder icon at the top
- Heading: `text-pf-deep`
- Body: `text-pf-deep/60`
- Back link: `border-pf-light text-pf-primary hover:border-pf-accent rounded-full`

---

## Phase 16 — Admin Console

> **Scope**: `apps/admin` — all pages and the shell component.  
> **Files changed**: `apps/admin/components/AdminShell.tsx`, `apps/admin/app/(app)/layout.tsx`, `apps/admin/app/(app)/page.tsx`, `apps/admin/app/(app)/clients/page.tsx`, `apps/admin/app/(app)/clients/[tenantId]/page.tsx`, `apps/admin/components/ClientStatusForm.tsx`, `apps/admin/components/TriggerDigestButton.tsx`

### AdminShell

Read the file. The admin shell is a separate deployment, intentionally distinct from the dashboard. Keep it dark (admin tools should feel different from the client-facing dashboard), but align it with the brand palette:

- Background: `bg-pf-deep`
- Sidebar: `bg-[#07192C]` (darker than pf-deep, distinct from dashboard)
- Active nav: `bg-pf-primary/30 text-white border-l-2 border-pf-accent`
- Inactive nav: `text-pf-light/60 hover:bg-pf-primary/20 hover:text-white`
- Logo at top: `<img src="/pathfinder-logo.svg" alt="PathFinder Admin" className="h-6 w-auto brightness-0 invert" />`
- Admin badge next to logo or below it: `rounded-full bg-pf-accent/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-pf-accent`

### Admin Pages

Apply the dark brand palette throughout:

- Page headings: `text-pf-light`
- Body text: `text-pf-light/60`
- Cards: `rounded-3xl border border-pf-primary/20 bg-pf-primary/10 p-6`
- Status badges: keep semantic colors (green active, red suspended, amber pending)
- CTA buttons: `bg-pf-accent text-white hover:bg-[#4d8de0] rounded-full`
- All `cyan-*` → `pf-accent`
- All `slate-*` dark → appropriate `pf-deep` / `pf-primary` tone

---

## Final Checklist (run after all phases complete)

After all phases are done, verify each of the following before considering the redesign complete:

### Search for Leftover Old Colors

Run these searches in the codebase and fix anything that appears in UI-facing files (not in comments or tests):

- `text-cyan-` — should be zero results in apps/ after redesign
- `bg-slate-950` — should be zero in dashboard/ (allowed in admin/ sidebar)
- `border-cyan-` — should be zero results
- `text-slate-950` — replace all occurrences with `text-pf-deep`
- `bg-slate-100` or `bg-slate-50` — replace with `bg-pf-surface` where used as a page background
- `focus:ring-cyan-` — replace with `focus:ring-pf-accent/20`

### Verify Font is Applied

- Open each of the three apps
- Inspect the body element — it should show Plus Jakarta Sans in the computed font stack
- Headlines should visibly differ from Inter or system-ui

### Verify Logo Renders

- Marketing page nav: full wordmark visible
- Dashboard sidebar top: full wordmark visible (on dark background)
- Guest chat header: small icon visible (or no logo if tight on space)
- Admin sidebar: full wordmark visible with `brightness-0 invert` filter for white on dark

### Verify Light Mode Chat

- Load the guest chat page on mobile device or mobile emulation
- White background should be readable in bright light
- User messages: brand blue (`pf-primary`)
- Assistant messages: light gray surface (`pf-surface`)
- Place cards: white background, rich with large photo area

### Verify No Regressions

- All existing functionality (form submissions, nav, analytics, onboarding flow) must work exactly as before
- No tRPC calls, hooks, auth guards, or data-fetching logic should be touched
- Only className strings, image sources, and JSX structure (for layout changes) are modified
- Tests must still pass: `turbo run typecheck && turbo run lint && turbo run test`

---

## Notes for Codex

1. **Do not install new packages.** All animation is done via the CSS `reveal` class defined in Phase 1's globals.css + the `FadeIn` component. No Framer Motion, no GSAP.
2. **`next/image` vs `<img>`**: Use `next/image` in Server Components and pages. Use `<img>` in client components (e.g., DashboardShell) where the image is a static local asset — `next/image` in client components requires config additions. All logos are SVG static assets, so `<img>` is acceptable.
3. **Placeholder hero**: The marketing page hero currently uses a CSS gradient as a background. When real venue photos are provided, replace the `<div>` with a `next/image` element with `fill` prop and `object-cover`, wrapped in `position: relative` with `overflow: hidden`.
4. **Preserve all business logic**: Every useEffect, tRPC call, analytics event, auth check, and form handler must remain byte-for-byte identical. Only className attributes and JSX structure (for layout changes) are touched.
5. **`pf-` color classes work only if the Tailwind config is extended (Phase 1F).** If a phase fails to apply brand colors, confirm Phase 1 was completed first.
6. **Q18 (guest chat feel) was left blank in the intake**. The decision taken is: light mode, white background, works in sunlight on a phone. This is consistent with the overall product being 2/5 darkness and with the REI/YETI reference aesthetic.
