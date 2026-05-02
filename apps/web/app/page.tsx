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
import Link from 'next/link'

import { FadeIn } from '../components/FadeIn'
import { PathFinderBrand } from '../components/PathFinderBrand'

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

export default function WebHomePage() {
  return (
    <div className="min-h-screen bg-pf-surface font-jakarta text-pf-deep">
      <header className="sticky top-0 z-50 border-b border-pf-light/60 bg-pf-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4 lg:px-10">
          <PathFinderBrand textClassName="text-pf-deep" />
          <a
            href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
            className="inline-flex min-h-10 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent"
          >
            Request a demo
          </a>
        </div>
      </header>

      <section className="relative overflow-hidden bg-pf-deep text-white">
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(135deg, #0F2A4A 0%, #1F4E8C 60%, #3A7BD5 100%)' }}
          aria-hidden="true"
        />
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
              Guests ask questions. PathFinder answers with real directions, hours, and
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
                  Start at River Otters. It opens at 9 AM and draws the biggest crowds by noon. From
                  there, the east path takes you to the touch pool in about 4 minutes.
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

      <section className="border-b border-pf-light bg-pf-white px-6 py-16 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-8 sm:grid-cols-3">
            {benefits.map((b) => (
              <div key={b.stat} className="flex flex-col gap-2">
                <span className="text-4xl font-semibold tracking-tight text-pf-primary">
                  {b.stat}
                </span>
                <p className="text-sm leading-6 text-pf-deep/60">{b.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

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
                body: 'PathFinder builds a guide that knows your specific layout, not generic directions.',
              },
              {
                step: '03',
                title: 'Guests get instant answers',
                body: 'Via QR code or link, on any phone, no app download required. It just works.',
              },
            ].map((item, index) => (
              <FadeIn key={item.step} delay={index * 100} className="h-full">
                <article className="h-full rounded-3xl border border-pf-light bg-pf-white p-7 shadow-sm">
                  <span className="text-4xl font-light text-pf-light">{item.step}</span>
                  <h3 className="mt-5 text-xl font-semibold tracking-tight">{item.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-pf-deep/60">{item.body}</p>
                </article>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

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

      <section className="px-6 py-24 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <FadeIn>
            <span className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              Who it&apos;s for
            </span>
            <h2 className="mt-4 max-w-2xl text-3xl font-semibold leading-snug tracking-tight sm:text-4xl">
              Built for real places with guests to guide.
            </h2>
          </FadeIn>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {venueTypes.map(({ label, icon: Icon }, index) => (
              <FadeIn key={label} delay={index * 80} className="h-full">
                <article className="h-full rounded-3xl border border-pf-light bg-pf-white p-5 shadow-sm">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-pf-accent/10 text-pf-primary">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h2 className="mt-5 text-base font-semibold leading-6">{label}</h2>
                </article>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-pf-deep px-6 py-20 text-white lg:px-10">
        <FadeIn className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-8 rounded-[2.5rem] border border-pf-light/20 bg-gradient-to-br from-pf-primary to-pf-accent p-8 sm:p-10 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Binoculars className="h-8 w-8 text-pf-light" aria-hidden="true" />
              <h2 className="mt-5 text-3xl font-semibold tracking-tight">
                Ready to give your guests a smarter experience?
              </h2>
            </div>
            <a
              href="mailto:tomschoenekase@gmail.com?subject=PathFinder%20demo%20request"
              className="inline-flex min-h-12 items-center justify-center rounded-full bg-pf-white px-6 text-sm font-semibold text-pf-primary transition hover:bg-pf-surface"
            >
              Get in touch
            </a>
          </div>
        </FadeIn>
      </section>

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
            <Link
              href="/privacy"
              className="text-xs text-pf-deep/40 transition hover:text-pf-primary"
            >
              Privacy Policy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  )
}
