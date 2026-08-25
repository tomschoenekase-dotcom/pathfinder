import type { Metadata } from 'next'
import React from 'react'
import Image from 'next/image'
import Link from 'next/link'

import { RequestDemoForm } from '../../components/RequestDemoForm'
import { TRPCProvider } from '../../lib/trpc'

export const metadata: Metadata = {
  title: 'Request a Torchiko demo',
  description: 'Tell Torchiko about your venue and what your guests need help with.',
}

export default function RequestDemoPage() {
  return (
    <main className="min-h-screen bg-pf-surface px-5 py-8 font-jakarta text-pf-deep sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <Link
          href="/"
          className="inline-flex items-center gap-3 text-sm font-semibold text-pf-primary"
        >
          <Image src="/torchiko-logo.svg" alt="" aria-hidden="true" width={40} height={40} />
          Torchiko
        </Link>
        <div className="mt-8 grid w-full min-w-0 overflow-hidden rounded-[2.25rem] border border-pf-light bg-white shadow-xl lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <section className="bg-pf-deep p-8 text-white sm:p-10 lg:p-12">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-pf-light/70">
              Remote setup
            </p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-tight">
              Show us your venue.
            </h1>
            <p className="mt-5 text-base leading-7 text-pf-light/75">
              Share a few practical details. The Torchiko team can review the fit and continue the
              conversation without requiring an on-site visit.
            </p>
            <ul className="mt-8 space-y-4 text-sm leading-6 text-pf-light/80">
              <li>Visitor answers grounded in your real venue information</li>
              <li>Bot and voice experiences that work from a guest&apos;s phone</li>
              <li>A guided onboarding process instead of a wall of settings</li>
            </ul>
          </section>
          <section className="min-w-0 p-7 sm:p-10 lg:p-12" aria-label="Demo request details">
            <h2 className="text-2xl font-semibold tracking-tight">Request a conversation</h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              Required fields are kept intentionally short.
            </p>
            <div className="mt-7">
              <TRPCProvider scopeKey="public-interest-intake">
                <RequestDemoForm />
              </TRPCProvider>
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}
