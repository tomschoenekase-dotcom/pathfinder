import type { Metadata } from 'next'
import Link from 'next/link'

import { TorchicoBrand } from '@pathfinder/ui'

export const metadata: Metadata = {
  title: 'Privacy notice — Torchico',
  description: 'Privacy and safe-use information for the Torchico evaluation service.',
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-pf-surface px-6 py-12 text-pf-deep sm:py-16">
      <article className="mx-auto max-w-2xl rounded-3xl border border-pf-light bg-pf-white p-7 shadow-sm sm:p-10">
        <TorchicoBrand textSizeClassName="text-lg" />
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.18em] text-pf-primary/60">
          Privacy notice
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight">Use staging safely</h1>
        <div className="mt-6 space-y-5 text-sm leading-7 text-pf-deep/70">
          <p>
            This service is currently available for product evaluation. A reviewed production
            privacy policy has not yet been published.
          </p>
          <p>
            Do not submit passwords, payment details, health information, government identifiers, or
            other sensitive personal information. Questions and feedback entered in a venue guide
            may be retained for testing and may be visible to that venue&apos;s authorized operators
            and Torchico administrators.
          </p>
          <p>
            Browser location is optional and is requested only when you choose a location-aware
            feature. You can deny or revoke that permission in your browser.
          </p>
          <p>
            For a privacy question or a request concerning information you submitted, email{' '}
            <a
              href="mailto:tomschoenekase@gmail.com?subject=Torchico%20privacy%20request"
              className="font-semibold text-pf-primary underline decoration-pf-accent/50 underline-offset-4 hover:text-pf-accent"
            >
              tomschoenekase@gmail.com
            </a>
            .
          </p>
        </div>
        <Link
          href="/"
          className="mt-10 inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-semibold text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
        >
          Back to Torchico
        </Link>
      </article>
    </main>
  )
}
