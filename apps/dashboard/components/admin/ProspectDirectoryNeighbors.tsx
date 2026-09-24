'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { readDirectoryNavigation } from '../../lib/prospect-directory-state'

export function ProspectDirectoryNeighbors({
  base,
  query,
  prospectId,
}: {
  base: string
  query?: string
  prospectId: string
}) {
  const [neighbors, setNeighbors] = useState<{
    previous: string | undefined
    next: string | undefined
    position: number
    count: number
  } | null>(null)

  useEffect(() => {
    setNeighbors(null)
    try {
      const saved = readDirectoryNavigation(window.sessionStorage, base, query ?? '')
      if (!saved) return
      const index = saved.ids.indexOf(prospectId)
      if (index < 0) return
      setNeighbors({
        previous: saved.ids[index - 1],
        next: saved.ids[index + 1],
        position: index + 1,
        count: saved.ids.length,
      })
    } catch {
      // Direct detail links work without session storage.
    }
  }, [base, prospectId, query])

  if (!neighbors || neighbors.count < 2) return null
  const detailHref = (id: string) =>
    `${base}/${encodeURIComponent(id)}?directoryQuery=${encodeURIComponent(query ?? '')}`

  return (
    <nav
      aria-label="Loaded directory records"
      className="flex flex-wrap items-center gap-3 text-xs text-slate-600"
    >
      <span>
        {neighbors.position} of {neighbors.count} loaded records
      </span>
      {neighbors.previous ? (
        <Link
          href={detailHref(neighbors.previous)}
          className="min-h-10 inline-flex items-center font-semibold text-sky-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          Previous record
        </Link>
      ) : null}
      {neighbors.next ? (
        <Link
          href={detailHref(neighbors.next)}
          className="min-h-10 inline-flex items-center font-semibold text-sky-800 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600"
        >
          Next record
        </Link>
      ) : null}
    </nav>
  )
}
