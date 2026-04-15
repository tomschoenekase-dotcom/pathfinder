import Link from 'next/link'

import type { Venue } from '@pathfinder/db'

type VenueCardProps = {
  venue: Pick<
    Venue,
    | 'id'
    | 'name'
    | 'slug'
    | 'category'
    | 'description'
    | 'isActive'
    | 'defaultCenterLat'
    | 'defaultCenterLng'
  > & {
    placeCount: number
  }
}

export function VenueCard({ venue }: VenueCardProps) {
  return (
    <Link
      href={`/venues/${venue.id}`}
      className="block rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:border-slate-300 hover:shadow-md"
    >
      <article>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-700">
              {venue.category ?? 'Venue'}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{venue.name}</h2>
            <p className="text-sm leading-6 text-slate-600">
              {venue.description ?? 'No description added yet.'}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              venue.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {venue.isActive ? 'Active' : 'Inactive'}
          </span>
        </div>

        <dl className="mt-5 grid gap-3 text-sm text-slate-600 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">Slug</dt>
            <dd className="mt-1 font-medium text-slate-800">{venue.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">Places</dt>
            <dd className="mt-1 font-medium text-slate-800">{venue.placeCount}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.18em] text-slate-400">Center</dt>
            <dd className="mt-1 font-medium text-slate-800">
              {venue.defaultCenterLat !== null && venue.defaultCenterLng !== null
                ? `${venue.defaultCenterLat}, ${venue.defaultCenterLng}`
                : 'Not set'}
            </dd>
          </div>
        </dl>
      </article>
    </Link>
  )
}
