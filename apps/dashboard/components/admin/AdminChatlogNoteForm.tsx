'use client'

import { FormEvent, useRef, useState } from 'react'

import { createTRPCClient } from '../../lib/trpc'

type Note = {
  id: string
  note: string
  authorId: string
  createdAt: Date
}

type AdminChatlogNoteFormProps = {
  tenantId: string
  venueId: string
  sessionId: string
  initialNotes: Note[]
}

export function AdminChatlogNoteForm({
  tenantId,
  venueId,
  sessionId,
  initialNotes,
}: AdminChatlogNoteFormProps) {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)
  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  const [notes, setNotes] = useState(initialNotes)
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = note.trim()
    if (!trimmed) return

    setPending(true)
    setErrorMessage(null)

    try {
      const created = await clientRef.current!.admin.addChatlogNote.mutate({
        tenantId,
        venueId,
        sessionId,
        note: trimmed,
      })
      setNotes((current) => [created, ...current])
      setNote('')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to add note.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          className="w-full rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-sm text-pf-deep outline-none transition focus:border-pf-primary"
          placeholder="Private admin note"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center rounded-full bg-pf-primary px-4 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Add note'}
        </button>
        {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
      </form>

      <div className="space-y-3">
        {notes.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-pf-light bg-pf-surface px-4 py-4 text-sm text-pf-deep/60">
            No admin notes yet.
          </p>
        ) : (
          notes.map((item) => (
            <div key={item.id} className="rounded-2xl border border-pf-light bg-pf-surface p-4">
              <p className="text-sm leading-6 text-pf-deep">{item.note}</p>
              <p className="mt-2 text-xs text-pf-deep/50">
                {item.authorId} - {item.createdAt.toLocaleString()}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
