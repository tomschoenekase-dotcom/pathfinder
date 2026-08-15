'use client'

import { useState } from 'react'

import { useTRPCClient } from '../lib/trpc'

type PlaceRow = {
  id: string
  name: string
  type: string
  visibility: string
  updatedAt: string
}

type KnowledgeRow = {
  id: string
  title: string
  category: string
  visibility: string
  updatedAt: string
}

export function SecondLayerContentManager({
  venueId,
  label,
  initialPlaces,
  initialKnowledge,
}: {
  venueId: string
  label: string
  initialPlaces: PlaceRow[]
  initialKnowledge: KnowledgeRow[]
}) {
  const client = useTRPCClient()
  const [places, setPlaces] = useState(initialPlaces)
  const [knowledge, setKnowledge] = useState(initialKnowledge)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function toggle(place: PlaceRow) {
    if (pendingId) return
    const visibility = place.visibility === 'SECOND_LAYER' ? 'PUBLIC' : 'SECOND_LAYER'
    setPendingId(place.id)
    setError(null)
    try {
      const saved = await client.place.setVisibility.mutate({
        id: place.id,
        venueId,
        visibility,
        expectedUpdatedAt: new Date(place.updatedAt),
      })
      setPlaces((current) =>
        current.map((item) =>
          item.id === place.id
            ? {
                ...item,
                visibility: saved.visibility,
                updatedAt: saved.updatedAt.toISOString(),
              }
            : item,
        ),
      )
    } catch {
      setError('That item changed or could not be updated. Refresh before trying again.')
    } finally {
      setPendingId(null)
    }
  }

  async function toggleKnowledge(entry: KnowledgeRow) {
    if (pendingId) return
    const visibility = entry.visibility === 'SECOND_LAYER' ? 'PUBLIC' : 'SECOND_LAYER'
    setPendingId(entry.id)
    setError(null)
    try {
      const saved = await client.knowledge.update.mutate({
        id: entry.id,
        venueId,
        visibility,
        expectedUpdatedAt: new Date(entry.updatedAt),
      })
      setKnowledge((current) =>
        current.map((item) =>
          item.id === entry.id
            ? {
                ...item,
                visibility: saved.visibility,
                updatedAt: saved.updatedAt.toISOString(),
              }
            : item,
        ),
      )
    } catch {
      setError('That knowledge entry changed or could not be updated. Refresh before trying again.')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-pf-primary">Premium second layer</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-pf-deep">{label} content</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-pf-deep/65">
          Tagged items are hidden from the public chatbot and available in the {label} chatbot,
          which also sees all public items.
        </p>
      </header>
      {error ? (
        <p className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      <section className="overflow-hidden rounded-2xl border border-pf-light bg-white">
        {places.length ? (
          <ul className="divide-y divide-pf-light">
            {places.map((place) => {
              const checked = place.visibility === 'SECOND_LAYER'
              return (
                <li key={place.id} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <p className="font-medium text-pf-deep">{place.name}</p>
                    <p className="text-xs text-pf-deep/50">{place.type.replace(/_/gu, ' ')}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-medium text-pf-deep/70">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={pendingId !== null}
                      onChange={() => void toggle(place)}
                    />
                    {label} only
                  </label>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="p-6 text-sm text-pf-deep/60">No guide items are available to tag yet.</p>
        )}
      </section>
      <section className="overflow-hidden rounded-2xl border border-pf-light bg-white">
        <div className="border-b border-pf-light p-4">
          <h2 className="font-semibold text-pf-deep">Knowledge</h2>
          <p className="mt-1 text-xs leading-5 text-pf-deep/55">
            Policies, procedures, and other freeform facts tagged here never enter the public
            assistant context.
          </p>
        </div>
        {knowledge.length ? (
          <ul className="divide-y divide-pf-light">
            {knowledge.map((entry) => {
              const checked = entry.visibility === 'SECOND_LAYER'
              return (
                <li key={entry.id} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <p className="font-medium text-pf-deep">{entry.title}</p>
                    <p className="text-xs text-pf-deep/50">{entry.category}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm font-medium text-pf-deep/70">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={pendingId !== null}
                      onChange={() => void toggleKnowledge(entry)}
                    />
                    {label} only
                  </label>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="p-6 text-sm text-pf-deep/60">
            No knowledge entries are available to tag yet.
          </p>
        )}
      </section>
    </div>
  )
}
