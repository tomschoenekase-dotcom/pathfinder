'use client'

import Link from 'next/link'

import { VenueForm } from '../../../../components/VenueForm'

export default function NewVenuePage() {
  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link href="/venues" className="text-sm font-medium text-pf-primary hover:text-pf-accent">
          Back to venues
        </Link>
        <VenueForm mode="create" />
      </div>
    </main>
  )
}
