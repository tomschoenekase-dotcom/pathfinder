'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'

import { PlaceForm } from '../../../../../../components/PlaceForm'

export default function NewPlacePage() {
  const params = useParams<{ venueId: string }>()

  return (
    <main className="min-h-screen bg-pf-surface px-6 py-10">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link
          href={`/venues/${params.venueId}`}
          className="text-sm font-medium text-pf-primary hover:text-pf-accent"
        >
          Back to venue
        </Link>
        <PlaceForm mode="create" venueId={params.venueId} />
      </div>
    </main>
  )
}
