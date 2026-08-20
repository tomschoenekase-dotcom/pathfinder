import React from 'react'
import Link from 'next/link'

export const metadata = {
  title: 'Privacy information | Torchiko',
  description: 'Current availability of Torchiko privacy information.',
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-pf-deep px-6 py-16 text-white">
      <div className="mx-auto max-w-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-white/60">Torchiko</p>
        <h1 className="mt-4 text-4xl font-semibold">Privacy information</h1>
        <div className="mt-8 rounded-2xl border border-amber-200/30 bg-amber-100/10 p-6">
          <h2 className="text-xl font-medium">Approved policy pending</h2>
          <p className="mt-3 leading-7 text-white/80">
            Torchiko&apos;s approved privacy policy is not available for publication yet. This page
            is a status notice, not a privacy policy. Until approved terms are posted, avoid sharing
            sensitive personal information with a venue guide and contact the venue directly for
            privacy questions.
          </p>
        </div>
        <p className="mt-8 text-white/70">
          The product team must approve the policy text and retention decisions before this notice
          can be replaced.
        </p>
        <Link className="mt-10 inline-block underline underline-offset-4" href="/">
          Return to Torchiko
        </Link>
      </div>
    </main>
  )
}
