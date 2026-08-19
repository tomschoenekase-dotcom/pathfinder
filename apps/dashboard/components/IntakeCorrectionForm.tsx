'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { useTRPCClient } from '../lib/trpc'
import { browserUuid } from '../lib/browser-uuid'

export function IntakeCorrectionForm({
  venueId,
  runId,
  expectedEventCount,
  sourceLabel,
}: {
  venueId: string
  runId: string
  expectedEventCount: number
  sourceLabel: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const operationId = useRef(browserUuid())
  const submitting = useRef(false)

  async function submit() {
    if (submitting.current || !body.trim()) return
    submitting.current = true
    setBusy(true)
    setMessage(null)
    try {
      await client.portal.createIntakeCorrectionRequest.mutate({
        operationId: operationId.current,
        venueId,
        runId,
        expectedEventCount,
        body: body.trim(),
      })
      setBody('')
      setOpen(false)
      operationId.current = browserUuid()
      setMessage('Correction recorded with this exact source. The original was not overwritten.')
      router.refresh()
    } catch (error) {
      setMessage(
        error instanceof Error && /changed/iu.test(error.message)
          ? 'This source changed before your correction was recorded. Refresh and try again; your text is still here.'
          : 'Torchiko could not record this correction. Your text is still here.',
      )
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="rounded-xl bg-pf-surface p-3"
        >
          <label className="block text-sm font-medium text-pf-deep">
            What should be corrected in {sourceLabel}?
            <textarea
              required
              maxLength={20_000}
              rows={4}
              value={body}
              disabled={busy}
              onChange={(event) => {
                setBody(event.target.value)
                operationId.current = browserUuid()
              }}
              className="mt-2 w-full rounded-xl border border-pf-light bg-white p-3"
            />
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy || !body.trim()}
              className="min-h-11 rounded-full bg-pf-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record correction'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setOpen(false)}
              className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-11 rounded-full border border-pf-light px-4 text-sm font-semibold text-pf-deep"
        >
          Suggest a correction
        </button>
      )}
      <p aria-live="polite" aria-atomic="true" className="mt-2 text-sm text-pf-deep/70">
        {message}
      </p>
    </div>
  )
}
