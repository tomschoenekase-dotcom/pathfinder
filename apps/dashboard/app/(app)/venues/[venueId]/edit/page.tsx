'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'

import { VenueForm } from '../../../../../components/VenueForm'

export default function EditVenuePage() {
  const params = useParams<{ venueId: string }>()

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link
          href={`/venues/${params.venueId}`}
          className="text-sm font-medium text-cyan-700 hover:text-cyan-800"
        >
          Back to venue
        </Link>
        <VenueForm mode="edit" venueId={params.venueId} />
      </div>
    </main>
  )
}
