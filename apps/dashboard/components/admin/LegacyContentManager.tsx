'use client'

import { type FormEvent, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { useTRPCClient } from '../../lib/trpc'

type Place = {
  id: string
  venueId: string
  name: string
  type: string
  shortDescription: string | null
  longDescription: string | null
  tags: string[]
  importanceScore: number
  isActive: boolean
  updatedAt: Date | string
}

type Knowledge = {
  id: string
  venueId: string
  title: string
  category: string
  content: string
  isEnabled: boolean
  updatedAt: Date | string
}

type Props = {
  tenantId: string
  venueId: string
  places: Place[]
  knowledgeEntries: Knowledge[]
}

function message(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The compatibility record could not be saved.'
}

function tags(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function LegacyContentManager({ tenantId, venueId, places, knowledgeEntries }: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const mutationInFlightRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editingPlace, setEditingPlace] = useState<Place | null>(null)
  const [editingKnowledge, setEditingKnowledge] = useState<Knowledge | null>(null)

  async function run(operation: () => Promise<unknown>, complete: () => void = () => undefined) {
    if (mutationInFlightRef.current) return
    mutationInFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      complete()
      router.refresh()
    } catch (cause) {
      setError(message(cause))
    } finally {
      mutationInFlightRef.current = false
      setBusy(false)
    }
  }

  function placeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const fields = {
      name: String(data.get('name') ?? '').trim(),
      type: String(data.get('type') ?? '').trim(),
      shortDescription: String(data.get('shortDescription') ?? '').trim() || null,
      longDescription: String(data.get('longDescription') ?? '').trim() || null,
      tags: tags(String(data.get('tags') ?? '')),
      importanceScore: Number(data.get('importanceScore') ?? 0),
    }
    if (editingPlace) {
      void run(
        () =>
          client.admin.updateLegacyPlace.mutate({
            tenantId,
            venueId,
            id: editingPlace.id,
            expectedUpdatedAt: new Date(editingPlace.updatedAt),
            fields,
          }),
        () => setEditingPlace(null),
      )
    } else {
      void run(
        () =>
          client.admin.createLegacyPlace.mutate({
            tenantId,
            venueId,
            fields: { ...fields, importanceScore: fields.importanceScore, isActive: true },
          }),
        () => form.reset(),
      )
    }
  }

  function knowledgeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const fields = {
      title: String(data.get('title') ?? '').trim(),
      category: String(data.get('category') ?? '').trim(),
      content: String(data.get('content') ?? '').trim(),
      isEnabled: editingKnowledge?.isEnabled ?? true,
    }
    if (editingKnowledge) {
      void run(
        () =>
          client.admin.updateLegacyKnowledge.mutate({
            tenantId,
            venueId,
            id: editingKnowledge.id,
            expectedUpdatedAt: new Date(editingKnowledge.updatedAt),
            fields,
          }),
        () => setEditingKnowledge(null),
      )
    } else {
      void run(
        () => client.admin.createLegacyKnowledge.mutate({ tenantId, venueId, fields }),
        () => form.reset(),
      )
    }
  }

  return (
    <div className="space-y-8">
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950"
        >
          {error} Your entered values are still here; refresh only when you are ready to reconcile.
        </div>
      ) : null}

      <section aria-labelledby="compatibility-places" className="space-y-4">
        <div>
          <h3 id="compatibility-places" className="text-lg font-semibold text-pf-deep">
            Compatibility Places
          </h3>
          <p className="text-sm text-pf-deep/70">Legacy location and guide-item records.</p>
        </div>
        <form
          key={editingPlace?.id ?? 'new-place'}
          onSubmit={placeSubmit}
          className="grid gap-3 rounded-2xl border border-pf-light bg-pf-surface/40 p-4 md:grid-cols-2"
        >
          <label className="text-sm font-medium text-pf-deep">
            Name
            <input
              name="name"
              required
              disabled={busy}
              defaultValue={editingPlace?.name}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Type
            <input
              name="type"
              required
              disabled={busy}
              defaultValue={editingPlace?.type}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep md:col-span-2">
            Short description
            <textarea
              name="shortDescription"
              disabled={busy}
              defaultValue={editingPlace?.shortDescription ?? ''}
              className="mt-1 min-h-20 w-full rounded-xl border border-pf-light p-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep md:col-span-2">
            Long description
            <textarea
              name="longDescription"
              disabled={busy}
              defaultValue={editingPlace?.longDescription ?? ''}
              className="mt-1 min-h-24 w-full rounded-xl border border-pf-light p-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Tags (comma-separated)
            <input
              name="tags"
              disabled={busy}
              defaultValue={editingPlace?.tags.join(', ')}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Importance (0–100)
            <input
              name="importanceScore"
              type="number"
              min="0"
              max="100"
              required
              disabled={busy}
              defaultValue={editingPlace?.importanceScore ?? 0}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={busy}
              className="min-h-11 rounded-xl bg-pf-primary px-4 font-semibold text-white"
            >
              {editingPlace ? 'Save Place changes' : 'Create Place'}
            </button>
            {editingPlace ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingPlace(null)}
                className="min-h-11 rounded-xl border border-pf-light px-4 font-semibold"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
        <div className="grid gap-3 xl:grid-cols-2">
          {places.map((place) => (
            <article key={place.id} className="rounded-2xl border border-pf-light bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-pf-deep">{place.name}</h4>
                  <p className="text-xs text-pf-deep/70">
                    {place.type} · {place.isActive ? 'active' : 'retired'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    aria-label={`Edit Place ${place.name}`}
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      setEditingPlace(place)
                    }}
                    className="rounded-lg border border-pf-light px-3 py-2 text-sm font-semibold"
                  >
                    Edit
                  </button>
                  {place.isActive ? (
                    <button
                      aria-label={`Retire Place ${place.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Retire compatibility Place “${place.name}”?`))
                          void run(() =>
                            client.admin.retireLegacyPlace.mutate({
                              tenantId,
                              venueId,
                              id: place.id,
                              expectedUpdatedAt: new Date(place.updatedAt),
                            }),
                          )
                      }}
                      className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-800"
                    >
                      Retire
                    </button>
                  ) : null}
                </div>
              </div>
              {place.shortDescription ? (
                <p className="mt-3 text-sm text-pf-deep/75">{place.shortDescription}</p>
              ) : null}
            </article>
          ))}
          {places.length === 0 ? (
            <p className="text-sm text-pf-deep/70">No compatibility Places.</p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="compatibility-knowledge" className="space-y-4">
        <div>
          <h3 id="compatibility-knowledge" className="text-lg font-semibold text-pf-deep">
            Compatibility Knowledge
          </h3>
          <p className="text-sm text-pf-deep/70">Legacy free-text retrieval records.</p>
        </div>
        <form
          key={editingKnowledge?.id ?? 'new-knowledge'}
          onSubmit={knowledgeSubmit}
          className="grid gap-3 rounded-2xl border border-pf-light bg-pf-surface/40 p-4 md:grid-cols-2"
        >
          <label className="text-sm font-medium text-pf-deep">
            Title
            <input
              name="title"
              required
              disabled={busy}
              defaultValue={editingKnowledge?.title}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep">
            Category
            <input
              name="category"
              required
              disabled={busy}
              defaultValue={editingKnowledge?.category ?? 'FAQ'}
              className="mt-1 min-h-11 w-full rounded-xl border border-pf-light px-3"
            />
          </label>
          <label className="text-sm font-medium text-pf-deep md:col-span-2">
            Content
            <textarea
              name="content"
              required
              disabled={busy}
              defaultValue={editingKnowledge?.content}
              className="mt-1 min-h-28 w-full rounded-xl border border-pf-light p-3"
            />
          </label>
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={busy}
              className="min-h-11 rounded-xl bg-pf-primary px-4 font-semibold text-white"
            >
              {editingKnowledge ? 'Save Knowledge changes' : 'Create Knowledge'}
            </button>
            {editingKnowledge ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditingKnowledge(null)}
                className="min-h-11 rounded-xl border border-pf-light px-4 font-semibold"
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
        <div className="grid gap-3 xl:grid-cols-2">
          {knowledgeEntries.map((entry) => (
            <article key={entry.id} className="rounded-2xl border border-pf-light bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-pf-deep">{entry.title}</h4>
                  <p className="text-xs text-pf-deep/70">
                    {entry.category} · {entry.isEnabled ? 'enabled' : 'retired'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    aria-label={`Edit Knowledge ${entry.title}`}
                    disabled={busy}
                    onClick={() => {
                      setError(null)
                      setEditingKnowledge(entry)
                    }}
                    className="rounded-lg border border-pf-light px-3 py-2 text-sm font-semibold"
                  >
                    Edit
                  </button>
                  {entry.isEnabled ? (
                    <button
                      aria-label={`Retire Knowledge ${entry.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Retire compatibility Knowledge “${entry.title}”?`))
                          void run(() =>
                            client.admin.retireLegacyKnowledge.mutate({
                              tenantId,
                              venueId,
                              id: entry.id,
                              expectedUpdatedAt: new Date(entry.updatedAt),
                            }),
                          )
                      }}
                      className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-800"
                    >
                      Retire
                    </button>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm text-pf-deep/75">
                {entry.content}
              </p>
            </article>
          ))}
          {knowledgeEntries.length === 0 ? (
            <p className="text-sm text-pf-deep/70">No compatibility Knowledge entries.</p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
