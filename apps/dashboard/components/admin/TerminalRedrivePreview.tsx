'use client'

import type { inferRouterOutputs } from '@trpc/server'
import { useEffect, useRef, useState } from 'react'

import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

type Preview = inferRouterOutputs<AppRouter>['admin']['previewTerminalJobRedrive']
const REDRIVE_READ_TIMEOUT_MS = 15_000

export function TerminalRedrivePreview({ jobRecordId }: { jobRecordId: string }) {
  const client = useTRPCClient()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sequence = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const currentJobRecordId = useRef(jobRecordId)
  currentJobRecordId.current = jobRecordId

  useEffect(() => {
    sequence.current += 1
    activeRequest.current?.abort()
    activeRequest.current = null
    setPreview(null)
    setPending(false)
    setError(null)
    return () => {
      sequence.current += 1
      activeRequest.current?.abort()
      activeRequest.current = null
    }
  }, [jobRecordId])

  async function inspect() {
    const startedSequence = ++sequence.current
    const startedJobRecordId = jobRecordId
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setPending(true)
    setError(null)
    setPreview(null)
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: REDRIVE_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.previewTerminalJobRedrive.query({ jobRecordId }, { signal }),
      })
      if (
        sequence.current === startedSequence &&
        currentJobRecordId.current === startedJobRecordId
      ) {
        setPreview(result)
      }
    } catch {
      if (
        sequence.current === startedSequence &&
        currentJobRecordId.current === startedJobRecordId
      ) {
        setError('Recovery evidence could not be loaded in time. Retry before preparing a redrive.')
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null
      if (
        sequence.current === startedSequence &&
        currentJobRecordId.current === startedJobRecordId
      ) {
        setPending(false)
      }
    }
  }

  return (
    <div className="mt-2 max-w-xl text-left">
      <button
        type="button"
        disabled={pending}
        onClick={() => void inspect()}
        className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-sky-800 hover:bg-sky-50 disabled:opacity-50"
      >
        {pending ? 'Checking live recovery evidence…' : 'Preview staging recovery'}
      </button>
      {error ? (
        <p className="mt-2 text-xs text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-slate-700">
          <p className="font-semibold text-emerald-900">
            Live failed-set evidence matches the persisted terminal record.
          </p>
          <dl className="mt-2 grid gap-1 sm:grid-cols-[8rem_1fr]">
            <dt className="font-semibold">Queue</dt>
            <dd className="break-all font-mono">{preview.preview.queueName}</dd>
            <dt className="font-semibold">Job type</dt>
            <dd className="break-all font-mono">{preview.preview.jobName}</dd>
            <dt className="font-semibold">BullMQ job ID</dt>
            <dd className="break-all font-mono">{preview.preview.bullJobId}</dd>
            <dt className="font-semibold">Attempts</dt>
            <dd>
              {preview.preview.attemptsMade} / {preview.preview.maxAttempts}
            </dd>
            <dt className="font-semibold">Terminal at</dt>
            <dd>{new Date(preview.preview.terminalAt).toLocaleString()}</dd>
            <dt className="font-semibold">Confirmation token</dt>
            <dd className="break-all font-mono">{preview.preview.confirmationToken}</dd>
          </dl>
          <p className="mt-2 font-medium text-slate-800">
            No action was taken. Execution remains available only through the separately gated,
            audited staging CLI after semantic side-effect review.
          </p>
        </div>
      ) : null}
    </div>
  )
}
