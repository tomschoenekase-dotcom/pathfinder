import Link from 'next/link'

import type { Place } from '@pathfinder/db'

type PlaceRowProps = {
  place: Pick<Place, 'id' | 'venueId' | 'name' | 'type' | 'areaName' | 'isActive'>
}

export function PlaceRow({ place }: PlaceRowProps) {
  return (
    <tr className="border-b border-pf-light last:border-b-0">
      <td className="px-4 py-4 align-top">
        <div className="font-medium text-pf-deep">{place.name}</div>
      </td>
      <td className="px-4 py-4 align-top text-pf-deep/60">{place.type}</td>
      <td className="px-4 py-4 align-top text-pf-deep/60">{place.areaName ?? 'Unknown area'}</td>
      <td className="px-4 py-4 align-top text-pf-deep/40">Pending</td>
      <td className="px-4 py-4 align-top">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            place.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-pf-surface text-pf-deep/40'
          }`}
        >
          {place.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-4 text-right align-top">
        <Link
          href={`/venues/${place.venueId}/places/${place.id}/edit`}
          className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
        >
          Edit
        </Link>
      </td>
    </tr>
  )
}
