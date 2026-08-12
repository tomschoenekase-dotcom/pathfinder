'use client'

import { useRef, useState } from 'react'

import { useTRPCClient } from '../../lib/trpc'

type Props = {
  tenantId: string
  venueId: string
  support?: { requestId: string; expectedVersion: number }
  intakeRunId?: string
}

export function ReviewedVenuePackageDraftForm(props: Props) {
  const client = useTRPCClient()
  const [text, setText] = useState('')
  const [reviewed, setReviewed] = useState<unknown>(null)
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const inFlight = useRef(false)
  const attemptedKey = useRef(false)

  function review() {
    setMessage(null)
    try {
      setReviewed(JSON.parse(text))
    } catch {
      setReviewed(null)
      setMessage('Enter valid VenuePackage JSON before review.')
    }
  }

  async function createDraft() {
    if (!reviewed || inFlight.current) return
    inFlight.current = true
    attemptedKey.current = true
    setBusy(true)
    setMessage(null)
    try {
      const common = {
        tenantId: props.tenantId,
        venueId: props.venueId,
        draftKey,
        payload: reviewed as never,
      }
      const result = props.support
        ? await client.admin.createAndLinkSupportReviewedVenuePackageDraft.mutate({
            ...common,
            supportRequestId: props.support.requestId,
            expectedVersion: props.support.expectedVersion,
          })
        : props.intakeRunId
          ? await client.admin.createAndLinkIntakeReviewedVenuePackageDraft.mutate({
              ...common,
              intakeRunId: props.intakeRunId,
            })
          : await client.admin.createReviewedVenuePackageDraft.mutate(common)
      setMessage(
        result.value.replayed
          ? 'The exact existing DRAFT was reconciled.'
          : props.support || props.intakeRunId
            ? 'The reviewed DRAFT was created and linked atomically.'
            : 'The reviewed DRAFT was created with complete semantic evidence.',
      )
      setDraftKey(crypto.randomUUID())
      attemptedKey.current = false
      setReviewed(null)
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'The reviewed DRAFT could not be created.',
      )
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <section
      className="rounded-2xl border border-pf-light bg-white p-5"
      aria-labelledby="draft-title"
    >
      <h3 id="draft-title" className="font-semibold text-pf-deep">
        Create a reviewed DRAFT
      </h3>
      <p className="mt-1 text-sm leading-6 text-pf-deep/75">
        Review the exact strict payload before submission. The request identity remains fixed for
        safe retry until success. Creation uses the canonical gated semantic-analysis pipeline and
        records only a DRAFT; it never approves, applies, publishes, or reverts content.
      </p>
      <label
        htmlFor="reviewed-package-json"
        className="mt-4 block text-sm font-semibold text-pf-deep"
      >
        VenuePackage payload JSON
      </label>
      <textarea
        id="reviewed-package-json"
        value={text}
        onChange={(event) => {
          if (attemptedKey.current) {
            setDraftKey(crypto.randomUUID())
            attemptedKey.current = false
          }
          setText(event.target.value)
          setReviewed(null)
          setMessage(null)
        }}
        rows={12}
        spellCheck={false}
        className="mt-2 w-full rounded-xl border border-pf-light p-3 font-mono text-xs"
      />
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={review}
          className="rounded-lg bg-pf-deep px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Review exact payload
        </button>
        <button
          type="button"
          disabled={busy || !reviewed}
          onClick={() => void createDraft()}
          className="rounded-lg bg-pf-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          Create DRAFT only
        </button>
      </div>
      {reviewed ? (
        <div
          className="mt-4 max-h-80 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100"
          aria-label="Reviewed VenuePackage payload"
        >
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(reviewed, null, 2)}</pre>
        </div>
      ) : null}
      {message ? (
        <p className="mt-3 text-sm text-pf-deep" role="status">
          {message}
        </p>
      ) : null}
    </section>
  )
}
