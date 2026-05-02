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
      className="block rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm transition hover:border-pf-accent/40 hover:shadow-md"
    >
      <article>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-pf-accent">
              {venue.category ?? 'Venue'}
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">{venue.name}</h2>
            <p className="text-sm leading-6 text-pf-deep/60">
              {venue.description ?? 'No description added yet.'}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              venue.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-pf-surface text-pf-deep/40'
            }`}
          >
            {venue.isActive ? 'Active' : 'Inactive'}
          </span>
        </div>

        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-widest text-pf-deep/30">Slug</dt>
            <dd className="mt-1 font-medium text-pf-deep">{venue.slug}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-widest text-pf-deep/30">Guide Items</dt>
            <dd className="mt-1 font-medium text-pf-deep">{venue.placeCount}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-widest text-pf-deep/30">Center</dt>
            <dd className="mt-1 font-medium text-pf-deep">
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
