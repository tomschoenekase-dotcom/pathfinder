import Link from 'next/link'

import type { Place } from '@pathfinder/db'

type PlaceRowProps = {
  place: Pick<Place, 'id' | 'venueId' | 'name' | 'type' | 'areaName' | 'isActive'>
}

export function PlaceRow({ place }: PlaceRowProps) {
  return (
    <tr className="border-b border-slate-200 last:border-b-0">
      <td className="px-4 py-4 align-top">
        <div className="font-medium text-slate-900">{place.name}</div>
      </td>
      <td className="px-4 py-4 align-top text-slate-600">{place.type}</td>
      <td className="px-4 py-4 align-top text-slate-600">{place.areaName ?? 'Unknown area'}</td>
      <td className="px-4 py-4 align-top text-slate-500">Pending</td>
      <td className="px-4 py-4 align-top">
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            place.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {place.isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="px-4 py-4 text-right align-top">
        <Link
          href={`/venues/${place.venueId}/places/${place.id}/edit`}
          className="inline-flex min-h-11 items-center rounded-full border border-slate-300 px-4 text-sm font-medium text-slate-700 transition hover:border-slate-400 hover:bg-slate-50"
        >
          Edit
        </Link>
      </td>
    </tr>
  )
}
