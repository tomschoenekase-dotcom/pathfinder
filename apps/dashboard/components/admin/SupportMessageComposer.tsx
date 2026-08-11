'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = { tenantId: string; venueId: string; requestId: string; expectedVersion: number }

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function SupportMessageComposer({ tenantId, venueId, requestId, expectedVersion }: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const [body, setBody] = useState('')
  const [revision, setRevision] = useState(expectedVersion)
  const [visibility, setVisibility] = useState<'CLIENT_VISIBLE' | 'INTERNAL_ONLY'>('INTERNAL_ONLY')
  const [pending, setPending] = useState(false)
  const [requiresRefresh, setRequiresRefresh] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const active = useRef(false)

  useEffect(() => {
    active.current = false
    setRevision(expectedVersion)
    setPending(false)
    setRequiresRefresh(false)
    setFeedback(null)
  }, [requestId, expectedVersion])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || requiresRefresh || !body.trim()) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = await client.admin.addSupportMessage.mutate({
        tenantId,
        venueId,
        requestId,
        expectedVersion: revision,
        visibility,
        body: body.trim(),
        attachments: [],
      })
      setRevision(result.requestVersion)
      setBody('')
      setFeedback({
        kind: 'success',
        text:
          visibility === 'INTERNAL_ONLY' ? 'Internal note added.' : 'Client-visible message added.',
      })
      router.refresh()
    } catch (error) {
      setRequiresRefresh(true)
      setFeedback({
        kind: 'error',
        text:
          errorCode(error) === 'CONFLICT'
            ? 'This request changed after the page loaded. Your draft is retained. Refresh before trying again.'
            : 'The message outcome could not be confirmed. Your draft is retained. Refresh before trying again.',
      })
      router.refresh()
    } finally {
      active.current = false
      setPending(false)
    }
  }

  async function reload() {
    if (active.current) return
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const request = await client.admin.getSupportRequest.query({ tenantId, venueId, requestId })
      setRevision(request.version)
      setRequiresRefresh(false)
      setFeedback({ kind: 'success', text: 'Request version refreshed. Your draft is retained.' })
      router.refresh()
    } catch {
      setFeedback({
        kind: 'error',
        text: 'The request version could not be refreshed. Your draft is retained and no new write was attempted.',
      })
    } finally {
      active.current = false
      setPending(false)
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="rounded-3xl border border-pf-light bg-white p-5 shadow-sm"
      aria-busy={pending}
    >
      <fieldset disabled={pending || requiresRefresh}>
        <legend className="text-lg font-semibold text-pf-deep">Add a message or note</legend>
        <p className="mt-1 text-sm text-pf-deep/65">
          Choose visibility deliberately. This does not change request status or apply any artifact.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label
            className={`rounded-2xl border p-4 ${visibility === 'INTERNAL_ONLY' ? 'border-pf-primary bg-pf-surface' : 'border-pf-light'}`}
          >
            <span className="flex items-center gap-2 font-semibold text-pf-deep">
              <input
                type="radio"
                name="visibility"
                value="INTERNAL_ONLY"
                checked={visibility === 'INTERNAL_ONLY'}
                onChange={() => setVisibility('INTERNAL_ONLY')}
              />{' '}
              Internal only
            </span>
            <span className="mt-1 block text-xs leading-5 text-pf-deep/65">
              Visible only inside PathFinder operations.
            </span>
          </label>
          <label
            className={`rounded-2xl border p-4 ${visibility === 'CLIENT_VISIBLE' ? 'border-sky-500 bg-sky-50' : 'border-pf-light'}`}
          >
            <span className="flex items-center gap-2 font-semibold text-pf-deep">
              <input
                type="radio"
                name="visibility"
                value="CLIENT_VISIBLE"
                checked={visibility === 'CLIENT_VISIBLE'}
                onChange={() => setVisibility('CLIENT_VISIBLE')}
              />{' '}
              Client visible
            </span>
            <span className="mt-1 block text-xs leading-5 text-pf-deep/65">
              Will be visible to the client in their support thread.
            </span>
          </label>
        </div>
        <label className="mt-4 grid gap-2 text-sm font-semibold text-pf-deep">
          Message
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={20_000}
            required
            className="rounded-2xl border border-pf-light bg-white px-4 py-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
          />
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!body.trim() || pending || requiresRefresh}
            className="min-h-11 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending
              ? 'Working…'
              : visibility === 'INTERNAL_ONLY'
                ? 'Add internal note'
                : 'Add client-visible message'}
          </button>
          <span className="text-xs text-pf-deep/55">Request version {revision}</span>
        </div>
      </fieldset>
      {requiresRefresh && !pending ? (
        <button
          type="button"
          onClick={() => void reload()}
          className="mt-3 min-h-10 rounded-xl border border-pf-light px-4 text-sm font-semibold text-pf-primary"
        >
          Refresh request
        </button>
      ) : null}
      {feedback ? (
        <p
          className={`mt-3 text-sm ${feedback.kind === 'error' ? 'text-rose-700' : 'text-emerald-700'}`}
          role={feedback.kind === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}
    </form>
  )
}
