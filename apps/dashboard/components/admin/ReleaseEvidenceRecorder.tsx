'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  ReleaseEvidenceRecordPayload,
  type ReleaseEvidenceRecordPayload as ReleaseEvidenceRecordPayloadValue,
} from '@pathfinder/contracts/release-evidence'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const RECORD_TIMEOUT_MS = 30_000

export function ReleaseEvidenceRecorder() {
  const client = useTRPCClient()
  const router = useRouter()
  const inFlight = useRef(false)
  const request = useRef<AbortController | null>(null)
  const feedbackHeading = useRef<HTMLHeadingElement>(null)
  const [payloadText, setPayloadText] = useState('')
  const [validated, setValidated] = useState<ReleaseEvidenceRecordPayloadValue | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState<'validate' | 'record' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () => () => {
      request.current?.abort()
      request.current = null
      inFlight.current = false
    },
    [],
  )

  useEffect(() => {
    if (message || error) feedbackHeading.current?.focus()
  }, [message, error])

  function changePayload(value: string) {
    setPayloadText(value)
    setValidated(null)
    setConfirmed(false)
    setMessage(null)
    setError(null)
  }

  function validate() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy('validate')
    setMessage(null)
    setError(null)
    try {
      const parsedJson: unknown = JSON.parse(payloadText)
      const result = ReleaseEvidenceRecordPayload.safeParse(parsedJson)
      if (!result.success) throw new Error('invalid-release-evidence')
      setValidated(result.data)
      setConfirmed(false)
      setMessage(
        `Validated ${result.data.assessment.profile} assessment for ${result.data.assessment.revision.slice(0, 8)}: ${result.data.assessment.summary.passed} passed, ${result.data.assessment.summary.failed} failed, ${result.data.assessment.summary.blocked} blocked.`,
      )
    } catch {
      setValidated(null)
      setConfirmed(false)
      setError('Paste the complete JSON emitted by the bounded release-evidence projector.')
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  async function record() {
    if (!validated || !confirmed || inFlight.current) return
    inFlight.current = true
    const controller = new AbortController()
    request.current = controller
    setBusy('record')
    setMessage(null)
    setError(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: RECORD_TIMEOUT_MS,
        request: (signal) => client.admin.recordReleaseEvidence.mutate(validated, { signal }),
      })
      setMessage(
        result.replayed
          ? 'This exact immutable release evidence was already recorded.'
          : 'Immutable release evidence recorded. Refreshing the Control Room.',
      )
      router.refresh()
    } catch {
      setError(
        'The recording outcome is unknown. Retry the unchanged validated payload; its operation identity makes an exact replay safe.',
      )
    } finally {
      if (request.current === controller) request.current = null
      inFlight.current = false
      setBusy(null)
    }
  }

  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
      <summary className="cursor-pointer text-sm font-semibold text-slate-950">
        Record a verified release assessment
      </summary>
      <div aria-busy={busy !== null} className="mt-4 max-w-4xl space-y-4">
        <p className="text-sm leading-6 text-slate-700">
          Paste only the JSON emitted by <code>release:evidence:prepare</code>. The server validates
          the complete assessment, exact revision, handoff lineage, and operation identity before
          appending evidence. This does not deploy, migrate, contact customers, change billing, or
          authorize production.
        </p>

        <div>
          <label
            className="text-sm font-semibold text-slate-900"
            htmlFor="release-evidence-payload"
          >
            Prepared release-evidence JSON
          </label>
          <textarea
            autoComplete="off"
            className="mt-2 min-h-56 w-full rounded-xl border border-slate-300 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-950 shadow-inner outline-none transition focus:border-sky-600 focus:ring-2 focus:ring-sky-200 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={busy !== null}
            id="release-evidence-payload"
            onChange={(event) => changePayload(event.target.value)}
            placeholder="Paste the complete projected JSON here."
            spellCheck={false}
            value={payloadText}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy !== null || payloadText.trim().length === 0}
            onClick={validate}
            type="button"
          >
            {busy === 'validate' ? 'Checking payload…' : 'Check payload'}
          </button>
          {validated ? (
            <code className="break-all text-xs text-slate-600">
              {validated.assessment.revision}
            </code>
          ) : null}
        </div>

        {validated ? (
          <label className="flex max-w-3xl items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
            <input
              checked={confirmed}
              className="mt-1 h-4 w-4 shrink-0 accent-sky-700"
              disabled={busy !== null}
              onChange={(event) => setConfirmed(event.target.checked)}
              type="checkbox"
            />
            <span>
              I verified this payload came from the bounded projector. Record it as immutable
              evidence only; grant no deployment or production authority.
            </span>
          </label>
        ) : null}

        {message || error ? (
          <section
            aria-live="polite"
            className={`rounded-xl border p-3 text-sm ${error ? 'border-rose-200 bg-rose-50 text-rose-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}
          >
            <h3 ref={feedbackHeading} tabIndex={-1} className="font-semibold">
              {error ? 'Release evidence needs attention' : 'Release evidence ready'}
            </h3>
            <p className="mt-1 leading-6">{error ?? message}</p>
          </section>
        ) : null}

        <button
          className="min-h-11 rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white transition-shadow hover:bg-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          disabled={!validated || !confirmed || busy !== null}
          onClick={() => void record()}
          type="button"
        >
          {busy === 'record' ? 'Recording immutable evidence…' : 'Record immutable evidence'}
        </button>
      </div>
    </details>
  )
}
