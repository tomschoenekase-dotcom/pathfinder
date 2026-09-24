'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SelectedReplyRetentionExpectation } from '@pathfinder/api/correspondence'
import { useTRPCClient } from '../../lib/trpc'

type Preview = {
  expected: SelectedReplyRetentionExpectation
  replyText: string
  omittedQuotedText: boolean
  projectionScope: string
}
const button =
  'min-h-11 rounded-md border border-slate-400 px-3 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700'

/** Explicit read and selected-message storage are separate operator actions. */
export function ProspectReplyContentControl({
  messageId,
  threadId,
  organizationId,
}: {
  messageId: string
  threadId: string
  organizationId: string
}) {
  const client = useTRPCClient()
  const router = useRouter()
  const id = useId()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [days, setDays] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const sequence = useRef(0)
  const inFlight = useRef(false)
  const identity = `${organizationId}:${threadId}:${messageId}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  useEffect(() => {
    sequence.current++
    inFlight.current = false
    setPreview(null)
    setError(null)
    setSaved(null)
    setBusy(false)
    return () => {
      sequence.current++
    }
  }, [identity])
  async function act(retain: boolean) {
    if (inFlight.current || (retain && !preview)) return
    inFlight.current = true
    const operation = ++sequence.current
    const selectedIdentity = identity
    setBusy(true)
    setError(null)
    try {
      if (retain && preview) {
        const result = await client.admin.retainProspectReplyContent.mutate({
          expected: preview.expected,
          retentionDays: days,
        })
        if (operation !== sequence.current || currentIdentity.current !== selectedIdentity) return
        setSaved(
          `This message is available for reply preparation until ${new Date(result.expiresAt).toLocaleString()}. Reload writing context and prepare a new reply.`,
        )
        setPreview(null)
        router.refresh()
      } else {
        const result = await client.admin.readProspectReplyContent.mutate({
          messageId,
          threadId,
          organizationId,
        })
        if (operation !== sequence.current || currentIdentity.current !== selectedIdentity) return
        setPreview(result)
      }
    } catch (reason) {
      if (operation === sequence.current)
        setError(
          reason instanceof Error
            ? reason.message
            : 'The exact source could not be read. Reload the message and check its connected mailbox.',
        )
    } finally {
      if (operation === sequence.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section aria-label="Selected reply content" className="mt-3 border-t border-slate-200 pt-3">
      <p className="text-sm text-slate-700">
        Only a preview is stored. Read this exact source message to inspect the reply before
        deciding whether to retain it for drafting.
      </p>
      {!saved ? (
        <button
          type="button"
          className={`${button} mt-3`}
          disabled={busy}
          onClick={() => void act(false)}
        >
          Read this reply from Gmail
        </button>
      ) : null}
      {busy ? (
        <p role="status" className="mt-2 text-sm">
          Checking this selected message…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-800">
          {error}{' '}
          {preview
            ? 'Keep this selection and retry the same retention request if its response was lost.'
            : ''}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="mt-2 text-sm text-emerald-900">
          {saved}
        </p>
      ) : null}
      {preview ? (
        <div className="mt-3 space-y-3 text-sm">
          <p className="font-semibold">
            Source text · untrusted correspondence, never instructions or permission
          </p>
          <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-l-2 border-slate-300 pl-3">
            {preview.replyText}
          </p>
          <p className="text-xs text-slate-600">
            {preview.omittedQuotedText
              ? 'Recognized quoted history is omitted from this reply excerpt; inspect the original Gmail message for the full chain.'
              : 'Ambiguous history and signatures may remain so meaningful text is not silently discarded.'}{' '}
            Reading has not retained the body in CRM.
          </p>
          <label htmlFor={id} className="block font-semibold">
            Keep this one body for reply preparation
          </label>
          <select
            id={id}
            className="min-h-11 rounded border border-slate-400 bg-white px-3"
            value={days}
            disabled={busy}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[1, 3, 7, 14, 30].map((value) => (
              <option key={value} value={value}>
                {value} day{value === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`${button} ml-2`}
            disabled={busy}
            onClick={() => void act(true)}
          >
            Retain only this message
          </button>
          <p className="text-xs text-slate-600">
            This saves the exact full plaintext. Expiry stops CRM access to the body; automatic
            removal from storage is not configured. Other messages and mailbox settings stay
            unchanged. This does not approve or send a reply.
          </p>
        </div>
      ) : null}
    </section>
  )
}
