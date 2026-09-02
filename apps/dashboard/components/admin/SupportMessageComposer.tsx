'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'

const SUPPORT_READ_TIMEOUT_MS = 15_000

type EligibleAttachment = {
  intakeUploadId: string
  fileName: string
  mimeType: string
  byteSize: number
  createdAt: Date | string
}
type Props = {
  tenantId: string
  venueId: string
  requestId: string
  expectedVersion: number
  initialEligibleAttachments?: EligibleAttachment[]
  initialEligibleAttachmentsNextCursor?: { createdAt: string; id: string } | null
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function errorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('data' in error)) return null
  const data = error.data
  return data && typeof data === 'object' && 'code' in data && typeof data.code === 'string'
    ? data.code
    : null
}

export function SupportMessageComposer({
  tenantId,
  venueId,
  requestId,
  expectedVersion,
  initialEligibleAttachments = [],
  initialEligibleAttachmentsNextCursor = null,
}: Props) {
  const client = useTRPCClient()
  const router = useRouter()
  const [body, setBody] = useState('')
  const [revision, setRevision] = useState(expectedVersion)
  const [visibility, setVisibility] = useState<'CLIENT_VISIBLE' | 'INTERNAL_ONLY'>('INTERNAL_ONLY')
  const [pending, setPending] = useState(false)
  const [requiresRefresh, setRequiresRefresh] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [attachments, setAttachments] = useState<string[]>([])
  const [eligibleAttachments, setEligibleAttachments] = useState(initialEligibleAttachments)
  const [eligibleAttachmentsNextCursor, setEligibleAttachmentsNextCursor] = useState(
    initialEligibleAttachmentsNextCursor,
  )
  const active = useRef(false)
  const readSequence = useRef(0)
  const activeRead = useRef<AbortController | null>(null)
  const operation = useRef<{ id: string; fingerprint: string } | null>(null)
  const scope = `${tenantId}:${venueId}:${requestId}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  useEffect(() => {
    readSequence.current += 1
    activeRead.current?.abort()
    activeRead.current = null
    active.current = false
    setRevision(expectedVersion)
    setPending(false)
    setRequiresRefresh(false)
    setFeedback(null)
  }, [expectedVersion, requestId, tenantId, venueId])

  useEffect(
    () => () => {
      readSequence.current += 1
      activeRead.current?.abort()
      activeRead.current = null
    },
    [],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (active.current || requiresRefresh || !body.trim()) return
    active.current = true
    setPending(true)
    setFeedback(null)
    const trimmedBody = body.trim()
    const fingerprint = JSON.stringify({
      tenantId,
      venueId,
      requestId,
      expectedVersion: revision,
      visibility,
      body: trimmedBody,
      attachments,
    })
    if (!operation.current || operation.current.fingerprint !== fingerprint) {
      operation.current = { id: crypto.randomUUID(), fingerprint }
    }
    try {
      const result = await client.admin.addSupportMessage.mutate({
        operationId: operation.current.id,
        tenantId,
        venueId,
        requestId,
        expectedVersion: revision,
        visibility,
        body: trimmedBody,
        attachments: attachments.map((intakeUploadId) => ({ intakeUploadId })),
      })
      setRevision(result.requestVersion)
      setBody('')
      setAttachments([])
      operation.current = null
      setFeedback({
        kind: 'success',
        text:
          visibility === 'INTERNAL_ONLY' ? 'Internal note added.' : 'Client-visible message added.',
      })
      router.refresh()
    } catch (error) {
      const conflict = errorCode(error) === 'CONFLICT'
      setRequiresRefresh(conflict)
      setFeedback({
        kind: 'error',
        text: conflict
          ? 'This request changed after the page loaded. Your draft is retained. Refresh before trying again.'
          : 'The message outcome could not be confirmed. Your draft and retry identity are retained; retry unchanged to check the original operation.',
      })
    } finally {
      active.current = false
      setPending(false)
    }
  }

  async function loadMoreAttachments() {
    if (active.current || !eligibleAttachmentsNextCursor) return
    const startedSequence = ++readSequence.current
    const startedScope = scope
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.listEligibleSupportAttachments.query(
            {
              tenantId,
              venueId,
              limit: 20,
              cursor: eligibleAttachmentsNextCursor,
            },
            { signal },
          ),
      })
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        setEligibleAttachments((current) => [
          ...current,
          ...next.items.filter(
            (row) => !current.some((existing) => existing.intakeUploadId === row.intakeUploadId),
          ),
        ])
        setEligibleAttachmentsNextCursor(next.nextCursor)
      }
    } catch {
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        setFeedback({
          kind: 'error',
          text: 'More files could not be loaded in time. No draft was changed. Retry when ready.',
        })
      }
    } finally {
      if (activeRead.current === controller) activeRead.current = null
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        active.current = false
        setPending(false)
      }
    }
  }

  async function reload() {
    if (active.current) return
    const startedSequence = ++readSequence.current
    const startedScope = scope
    activeRead.current?.abort()
    const controller = new AbortController()
    activeRead.current = controller
    active.current = true
    setPending(true)
    setFeedback(null)
    try {
      const request = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.admin.getSupportRequest.query({ tenantId, venueId, requestId }, { signal }),
      })
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        setRevision(request.version)
        setRequiresRefresh(false)
        setFeedback({ kind: 'success', text: 'Request version refreshed. Your draft is retained.' })
        router.refresh()
      }
    } catch {
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        setFeedback({
          kind: 'error',
          text: 'The request version could not be refreshed in time. Your draft is retained and no new write was attempted. Retry when ready.',
        })
      }
    } finally {
      if (activeRead.current === controller) activeRead.current = null
      if (readSequence.current === startedSequence && currentScope.current === startedScope) {
        active.current = false
        setPending(false)
      }
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
              Visible only inside Torchiko operations.
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
        <fieldset className="mt-4 rounded-2xl border border-pf-light bg-pf-surface/50 p-4">
          <legend className="px-1 text-sm font-semibold text-pf-deep">
            Files for Torchiko review (optional)
          </legend>
          <p id="admin-support-file-help" className="mt-1 text-xs leading-5 text-pf-deep/70">
            Files stay in quarantine for Torchiko review. Only files whose required checks are
            complete can be selected here. A completed scanner result is not a guarantee that a file
            is safe, readable, or malware-free. Files cannot be previewed or downloaded here.
          </p>
          {eligibleAttachments.length ? (
            <label className="mt-3 block text-sm font-medium text-pf-deep">
              Choose a recent venue file
              <select
                aria-describedby="admin-support-file-help"
                disabled={pending || requiresRefresh || attachments.length >= 20}
                value=""
                onChange={(event) => {
                  const id = event.target.value
                  if (id && !attachments.includes(id)) setAttachments((current) => [...current, id])
                }}
                className="mt-2 block min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 disabled:opacity-50"
              >
                <option value="">Select a file</option>
                {eligibleAttachments
                  .filter((row) => !attachments.includes(row.intakeUploadId))
                  .map((row) => (
                    <option key={row.intakeUploadId} value={row.intakeUploadId}>
                      {row.fileName} ({fileSize(row.byteSize)})
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <p className="mt-3 text-sm text-pf-deep/70">
              No recent files have completed the required checks.
            </p>
          )}
          {attachments.length ? (
            <ul className="mt-3 space-y-2" aria-label="Selected files">
              {attachments.map((id) => {
                const row = eligibleAttachments.find((candidate) => candidate.intakeUploadId === id)
                return row ? (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm"
                  >
                    <span>
                      <strong className="block text-pf-deep">{row.fileName}</strong>
                      <span className="text-xs text-pf-deep/65">
                        {row.mimeType} · {fileSize(row.byteSize)} · Awaiting Torchiko review
                      </span>
                    </span>
                    <button
                      type="button"
                      disabled={pending || requiresRefresh}
                      aria-label={`Remove ${row.fileName}`}
                      onClick={() =>
                        setAttachments((current) => current.filter((value) => value !== id))
                      }
                      className="min-h-11 rounded-lg px-3 text-sm font-semibold text-pf-primary disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </li>
                ) : null
              })}
            </ul>
          ) : null}
          {eligibleAttachmentsNextCursor ? (
            <button
              type="button"
              disabled={pending || requiresRefresh}
              onClick={() => void loadMoreAttachments()}
              className="mt-3 min-h-11 rounded-xl border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
            >
              {pending ? 'Loading files…' : 'Show more recent files'}
            </button>
          ) : null}
        </fieldset>
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
