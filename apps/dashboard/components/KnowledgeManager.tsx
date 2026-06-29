'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

import { CreateKnowledgeEntryInput, UpdateKnowledgeEntryInput } from '@pathfinder/api/schemas'

import { createTRPCClient } from '../lib/trpc'

type KnowledgeEntry = {
  id: string
  venueId: string
  title: string
  category: string
  content: string
  isEnabled: boolean
}

type KnowledgeFormValues = {
  title: string
  category: string
  content: string
  isEnabled: boolean
}

type KnowledgeManagerProps = {
  venueId: string
  initialEntries: KnowledgeEntry[]
}

const CATEGORY_SUGGESTIONS = ['FAQ', 'Policy', 'History', 'Services', 'Hours', 'Accessibility']

const EMPTY_FORM: KnowledgeFormValues = {
  title: '',
  category: 'FAQ',
  content: '',
  isEnabled: true,
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Something went wrong. Please try again.'
}

export function KnowledgeManager({ venueId, initialEntries }: KnowledgeManagerProps) {
  const router = useRouter()
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) clientRef.current = createTRPCClient()
  const client = clientRef.current

  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null)
  const [values, setValues] = useState<KnowledgeFormValues>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function startCreate() {
    setEditingEntry(null)
    setValues(EMPTY_FORM)
    setFormError(null)
  }

  function startEdit(entry: KnowledgeEntry) {
    setEditingEntry(entry)
    setValues({
      title: entry.title,
      category: entry.category,
      content: entry.content,
      isEnabled: entry.isEnabled,
    })
    setFormError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setIsSaving(true)

    try {
      if (editingEntry) {
        await client.knowledge.update.mutate(
          UpdateKnowledgeEntryInput.parse({
            id: editingEntry.id,
            ...values,
          }),
        )
      } else {
        await client.knowledge.create.mutate(
          CreateKnowledgeEntryInput.parse({
            venueId,
            ...values,
          }),
        )
      }

      startCreate()
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }

  async function toggleEnabled(entry: KnowledgeEntry) {
    setFormError(null)

    try {
      await client.knowledge.update.mutate({ id: entry.id, isEnabled: !entry.isEnabled })
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    }
  }

  async function handleDelete(entry: KnowledgeEntry) {
    const confirmed = window.confirm(`Delete "${entry.title}"? This cannot be undone.`)

    if (!confirmed) {
      return
    }

    setDeletingId(entry.id)
    setFormError(null)

    try {
      await client.knowledge.delete.mutate({ id: entry.id })
      if (editingEntry?.id === entry.id) {
        startCreate()
      }
      router.refresh()
    } catch (error) {
      setFormError(getErrorMessage(error))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="overflow-hidden rounded-[2rem] border border-pf-light bg-pf-white shadow-sm">
        <div className="flex flex-col gap-3 border-b border-pf-light px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">Entries</h2>
            <p className="mt-1 text-sm leading-6 text-pf-deep/60">
              Freeform venue information used by the AI guide.
            </p>
          </div>
          <button
            type="button"
            onClick={startCreate}
            className="inline-flex min-h-10 items-center justify-center rounded-full bg-pf-primary px-4 text-sm font-medium text-white transition hover:bg-pf-accent"
          >
            New entry
          </button>
        </div>

        {initialEntries.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-lg font-medium text-pf-deep">No knowledge entries yet.</p>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              Add policies, FAQs, hours, accessibility notes, or venue history.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-pf-surface text-left text-pf-deep/50">
                <tr>
                  <th className="px-6 py-3 font-medium">Title</th>
                  <th className="px-6 py-3 font-medium">Category</th>
                  <th className="px-6 py-3 font-medium">Enabled</th>
                  <th className="px-6 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {initialEntries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-t border-pf-light transition-colors hover:bg-pf-surface"
                  >
                    <td className="max-w-md px-6 py-4 align-top">
                      <div className="font-medium text-pf-deep">{entry.title}</div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-pf-deep/50">
                        {entry.content}
                      </p>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <span className="inline-flex rounded-full border border-pf-light bg-pf-surface px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-pf-primary">
                        {entry.category}
                      </span>
                    </td>
                    <td className="px-6 py-4 align-top">
                      <button
                        type="button"
                        onClick={() => {
                          void toggleEnabled(entry)
                        }}
                        className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold ${
                          entry.isEnabled
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-pf-surface text-pf-deep/40'
                        }`}
                      >
                        {entry.isEnabled ? 'Enabled' : 'Disabled'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right align-top">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(entry)}
                          className="inline-flex min-h-9 items-center rounded-full border border-pf-light px-4 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === entry.id}
                          onClick={() => {
                            void handleDelete(entry)
                          }}
                          className="inline-flex min-h-9 items-center rounded-full border border-rose-200 px-4 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-[2rem] border border-pf-light bg-pf-white p-6 shadow-sm">
        <h2 className="text-2xl font-semibold tracking-tight text-pf-deep">
          {editingEntry ? 'Edit entry' : 'Create entry'}
        </h2>
        <form className="mt-5 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="kb-title">
              Title
            </label>
            <input
              id="kb-title"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              maxLength={200}
              value={values.title}
              onChange={(event) =>
                setValues((current) => ({ ...current, title: event.target.value }))
              }
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-pf-deep/70" htmlFor="kb-category">
              Category
            </label>
            <input
              id="kb-category"
              className="min-h-11 w-full rounded-2xl border border-pf-light px-4 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              list="knowledge-categories"
              maxLength={100}
              value={values.category}
              onChange={(event) =>
                setValues((current) => ({ ...current, category: event.target.value }))
              }
              required
            />
            <datalist id="knowledge-categories">
              {CATEGORY_SUGGESTIONS.map((category) => (
                <option key={category} value={category} />
              ))}
            </datalist>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="block text-sm font-medium text-pf-deep/70" htmlFor="kb-content">
                Content
              </label>
              <span className="text-xs text-pf-deep/40">{values.content.length}/5000</span>
            </div>
            <textarea
              id="kb-content"
              className="min-h-48 w-full rounded-2xl border border-pf-light px-4 py-3 text-pf-deep outline-none transition focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
              maxLength={5000}
              value={values.content}
              onChange={(event) =>
                setValues((current) => ({ ...current, content: event.target.value }))
              }
              required
            />
          </div>

          <label className="flex items-center gap-3 rounded-2xl border border-pf-light px-4 py-3 text-sm text-pf-deep/70">
            <input
              className="h-4 w-4"
              type="checkbox"
              checked={values.isEnabled}
              onChange={(event) =>
                setValues((current) => ({ ...current, isEnabled: event.target.checked }))
              }
            />
            Enabled
          </label>

          <p className="rounded-2xl border border-pf-light bg-pf-surface px-4 py-3 text-xs leading-5 text-pf-deep/60">
            Entries are embedded in the background after saving. New entries become searchable
            within seconds.
          </p>

          {formError ? (
            <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {formError}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-3">
            {editingEntry ? (
              <button
                type="button"
                onClick={startCreate}
                className="inline-flex min-h-11 items-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent hover:bg-pf-accent/5"
              >
                Cancel
              </button>
            ) : (
              <div />
            )}
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex min-h-11 items-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light"
            >
              {isSaving ? 'Saving...' : editingEntry ? 'Save changes' : 'Create entry'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
