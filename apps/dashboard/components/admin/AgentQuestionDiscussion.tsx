'use client'

import { useEffect, useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = { tenantId: string; venueId: string; questionId: string }
type Note = { id: string; authorId: string; body: string; createdAt: Date | string }
type Cursor = { createdAt: string; id: string } | null
type Submission = Props & { operationId: string; body: string }

export function AgentQuestionDiscussion(props: Props) {
  return (
    <DiscussionThread
      key={JSON.stringify([props.tenantId, props.venueId, props.questionId])}
      {...props}
    />
  )
}

function DiscussionThread({ tenantId, venueId, questionId }: Props) {
  const client = useTRPCClient()
  const clientRef = useRef(client)
  clientRef.current = client
  const mounted = useRef(true)
  const reading = useRef(false)
  const writing = useRef(false)
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [cursor, setCursor] = useState<Cursor>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [body, setBody] = useState('')
  const [pending, setPending] = useState(false)
  const [retry, setRetry] = useState<Submission | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  async function load(older: boolean) {
    if (reading.current || writing.current) return
    reading.current = true
    setLoading(true)
    setLoadError(false)
    try {
      const result = await clientRef.current.admin.listAgentQuestionDiscussion.query({
        tenantId,
        venueId,
        questionId,
        limit: 20,
        ...(older && cursor ? { cursor } : {}),
      })
      if (!mounted.current) return
      setNotes((current) => {
        const combined = older ? [...current, ...result.items] : result.items
        return [...new Map(combined.map((note) => [note.id, note])).values()]
      })
      setCursor(result.nextCursor)
      setLoaded(true)
    } catch {
      if (mounted.current) setLoadError(true)
    } finally {
      if (mounted.current) setLoading(false)
      reading.current = false
    }
  }

  async function submit() {
    if (writing.current || reading.current || !body.trim() || body.trim().length > 5_000) return
    const payload = retry ?? {
      tenantId,
      venueId,
      questionId,
      operationId: crypto.randomUUID(),
      body: body.trim(),
    }
    writing.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await clientRef.current.admin.appendAgentQuestionDiscussion.mutate(payload)
      if (!mounted.current) return
      setNotes((current) =>
        [result.message, ...current.filter((note) => note.id !== result.message.id)].sort(
          (left, right) =>
            new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() ||
            right.id.localeCompare(left.id),
        ),
      )
      setRetry(null)
      setBody('')
      setFeedback('Note saved. The question and its answer are unchanged.')
    } catch {
      if (!mounted.current) return
      setRetry(payload)
      setFeedback(
        'Saving could not be confirmed. Retry this same note to check or finish saving it.',
      )
    } finally {
      if (mounted.current) setPending(false)
      writing.current = false
    }
  }

  return (
    <details
      className="mt-5 min-w-0 border-t border-slate-200 pt-4"
      onToggle={(event) => {
        const isOpen = event.currentTarget.open
        setOpen(isOpen)
        if (isOpen && !loaded) void load(false)
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-pf-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">
        Question discussion
      </summary>
      {open ? (
        <div className="mt-3 min-w-0 space-y-3 text-sm">
          <p className="text-slate-600">
            Operator notes stay with this question. Use the answer controls to resolve it; notes do
            not resume work or approve actions.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-500">Newest notes first</span>
            <button
              type="button"
              disabled={loading || pending}
              onClick={() => void load(false)}
              className="min-h-10 text-sm font-semibold text-pf-deep underline disabled:opacity-50"
            >
              Refresh notes
            </button>
          </div>
          {loading ? <p role="status">Loading notes…</p> : null}
          {loadError ? (
            <p role="alert">Notes could not be loaded. Use Refresh notes to try again.</p>
          ) : null}
          {loaded && notes.length === 0 && !loadError ? (
            <p className="text-slate-500">No discussion notes yet.</p>
          ) : null}
          <ol className="divide-y divide-slate-200">
            {notes.map((note) => (
              <li key={note.id} className="min-w-0 py-3">
                <p className="break-words text-xs text-slate-500">
                  Operator {note.authorId} ·{' '}
                  <time dateTime={new Date(note.createdAt).toISOString()}>
                    {new Date(note.createdAt).toLocaleString()}
                  </time>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-slate-800 [overflow-wrap:anywhere]">
                  {note.body}
                </p>
              </li>
            ))}
          </ol>
          {cursor ? (
            <button
              type="button"
              disabled={loading || pending}
              onClick={() => void load(true)}
              className="min-h-10 font-semibold text-pf-deep underline disabled:opacity-50"
            >
              Load older notes
            </button>
          ) : null}
          <label className="grid gap-2 font-semibold text-pf-deep">
            Add an operator note
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={pending || Boolean(retry)}
              maxLength={5_000}
              rows={3}
              className="min-w-0 w-full rounded-xl border border-slate-300 bg-white p-3 font-normal disabled:bg-slate-50"
            />
          </label>
          <button
            type="button"
            disabled={pending || loading || !body.trim() || body.trim().length > 5_000}
            onClick={() => void submit()}
            className="min-h-11 rounded-xl bg-pf-deep px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {pending ? 'Saving note…' : retry ? 'Retry same note' : 'Save note'}
          </button>
          {feedback ? (
            <p role="status" className="text-slate-700">
              {feedback}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}
