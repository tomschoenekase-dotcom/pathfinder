'use client'

import { type FormEvent, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Plus,
  Send,
} from 'lucide-react'

import { useTRPCClient } from '../lib/trpc'

type VenueOption = { id: string; name: string }
type EligibleAttachment = {
  intakeUploadId: string
  fileName: string
  mimeType: string
  byteSize: number
  createdAt: Date | string
}
type EligibleAttachmentCursor = { createdAt: string; id: string }
type RequestSummary = {
  id: string
  venueId: string
  category: string
  status: string
  subject: string
  missingInformation: string[]
  version: number
  statusChangedAt: Date | string
  createdAt: Date | string
  updatedAt: Date | string
}
type Attachment = {
  id: string
  filename: string
  mediaType: string
  byteSize: string | bigint
}
type ClientMessage = {
  id: string
  authorKind: string
  visibility: string
  body: string
  createdAt: Date | string
  attachments: Attachment[]
}
type RequestDetail = RequestSummary & {
  messages: ClientMessage[]
  nextMessageCursor: { createdAt: string; id: string } | null
}

type SupportWorkspaceProps = {
  venues: VenueOption[]
  activeVenue: VenueOption
  initialRequests: RequestSummary[]
  initialNextCursor: { updatedAt: string; id: string } | null
  initialDetail: RequestDetail | null
  initialEligibleAttachments: EligibleAttachment[]
  initialEligibleAttachmentsNextCursor: EligibleAttachmentCursor | null
}

const categories = [
  ['GENERAL', 'General question'],
  ['CONTENT_CORRECTION', 'Correct visitor information'],
  ['OPERATIONAL_UPDATE', 'Temporary visitor update'],
  ['BRANDING', 'Branding or appearance'],
  ['EXPERIENCE_BEHAVIOR', 'PathFinder behavior'],
  ['ACCESSIBILITY', 'Accessibility'],
] as const

const statusLabels: Record<string, string> = {
  OPEN: 'Received',
  WAITING_FOR_CLIENT: 'Waiting for your reply',
  IN_REVIEW: 'In review',
  PATCH_DRAFTED: 'Preparing an update',
  VALIDATING: 'Checking the update',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPLYING: 'Updating PathFinder',
  COMPLETED: 'Completed',
  CANCELLED: 'Closed',
}

function dateLabel(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}

function errorText(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong. Your draft is still here.'
}

function writeErrorText(error: unknown) {
  const message = error instanceof Error && error.message ? error.message : 'Something went wrong.'
  return `${message} Your draft is still here.`
}

function isConflict(error: unknown) {
  return (
    (error as { data?: { code?: unknown } } | null)?.data?.code === 'CONFLICT' ||
    (error as { shape?: { data?: { code?: unknown } } } | null)?.shape?.data?.code === 'CONFLICT' ||
    (error instanceof Error && /changed|conflict/i.test(error.message))
  )
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function AttachmentPicker({
  available,
  selected,
  disabled,
  label,
  onChange,
}: {
  available: EligibleAttachment[]
  selected: string[]
  disabled: boolean
  label: string
  onChange: (ids: string[]) => void
}) {
  const id = useId()
  const selectedRows = selected.flatMap((selectedId) => {
    const row = available.find((candidate) => candidate.intakeUploadId === selectedId)
    return row ? [row] : []
  })
  return (
    <fieldset className="rounded-2xl border border-pf-light bg-pf-surface/50 p-4">
      <legend className="px-1 text-sm font-semibold text-pf-deep">{label}</legend>
      <p id={`${id}-help`} className="mt-1 text-xs leading-5 text-pf-deep/70">
        Files stay in quarantine for PathFinder review. Upload verification confirms the stored
        object version, declared media type, size, and checksum only. It does not confirm that a
        file is safe, readable, or malware-free. Files cannot be previewed or downloaded here.
      </p>
      {available.length ? (
        <label className="mt-3 block text-sm font-medium text-pf-deep">
          Choose one of your recent files
          <select
            aria-describedby={`${id}-help`}
            disabled={disabled || selected.length >= 20}
            value=""
            onChange={(event) => {
              const next = event.target.value
              if (next && !selected.includes(next)) onChange([...selected, next])
            }}
            className="mt-2 block min-h-11 w-full rounded-xl border border-pf-light bg-white px-3 disabled:opacity-50"
          >
            <option value="">Select a file</option>
            {available
              .filter((row) => !selected.includes(row.intakeUploadId))
              .map((row) => (
                <option key={row.intakeUploadId} value={row.intakeUploadId}>
                  {row.fileName} ({fileSize(row.byteSize)})
                </option>
              ))}
          </select>
        </label>
      ) : (
        <p className="mt-3 text-sm text-pf-deep/70">No recent files are available for review.</p>
      )}
      {selectedRows.length ? (
        <ul className="mt-3 space-y-2" aria-label="Selected files">
          {selectedRows.map((row) => (
            <li
              key={row.intakeUploadId}
              className="flex items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm"
            >
              <span>
                <strong className="block text-pf-deep">{row.fileName}</strong>
                <span className="text-xs text-pf-deep/65">
                  {row.mimeType} · {fileSize(row.byteSize)} · Awaiting PathFinder review
                </span>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange(selected.filter((candidate) => candidate !== row.intakeUploadId))
                }
                aria-label={`Remove ${row.fileName}`}
                className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-pf-primary disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  )
}

export function SupportWorkspace({
  venues,
  activeVenue,
  initialRequests,
  initialNextCursor,
  initialDetail,
  initialEligibleAttachments,
  initialEligibleAttachmentsNextCursor,
}: SupportWorkspaceProps) {
  const router = useRouter()
  const client = useTRPCClient()
  const [requests, setRequests] = useState(initialRequests)
  const [nextCursor, setNextCursor] = useState(initialNextCursor)
  const [detail, setDetail] = useState(initialDetail)
  const [view, setView] = useState<'conversation' | 'create'>(
    initialDetail ? 'conversation' : 'create',
  )
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState<(typeof categories)[number][0]>('GENERAL')
  const [requestBody, setRequestBody] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [createAttachments, setCreateAttachments] = useState<string[]>([])
  const [replyAttachments, setReplyAttachments] = useState<string[]>([])
  const [eligibleAttachments, setEligibleAttachments] = useState(initialEligibleAttachments)
  const [eligibleAttachmentsNextCursor, setEligibleAttachmentsNextCursor] = useState(
    initialEligibleAttachmentsNextCursor,
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const writeInFlight = useRef(false)
  const createOperationId = useRef(crypto.randomUUID())
  const replyOperationId = useRef(crypto.randomUUID())

  function changeCreateDraft(change: () => void) {
    change()
    createOperationId.current = crypto.randomUUID()
  }
  function changeReplyDraft(change: () => void) {
    change()
    replyOperationId.current = crypto.randomUUID()
  }

  function clearFeedback() {
    setNotice(null)
    setError(null)
    setConflict(false)
  }

  async function openRequest(requestId: string) {
    if (writeInFlight.current) return
    clearFeedback()
    setBusy('detail')
    try {
      const next = await client.support.getRequest.query({
        venueId: activeVenue.id,
        requestId,
      })
      if (detail?.id !== requestId || next.status === 'COMPLETED' || next.status === 'CANCELLED') {
        setReplyBody('')
        setReplyAttachments([])
      }
      setDetail(next as RequestDetail)
      replyOperationId.current = crypto.randomUUID()
      setView('conversation')
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setBusy(null)
    }
  }

  async function loadMoreEligibleAttachments() {
    if (!eligibleAttachmentsNextCursor || busy) return
    clearFeedback()
    setBusy('attachments')
    try {
      const next = await client.support.listEligibleAttachments.query({
        venueId: activeVenue.id,
        limit: 20,
        cursor: eligibleAttachmentsNextCursor,
      })
      setEligibleAttachments((current) => [
        ...current,
        ...next.items.filter(
          (row) => !current.some((existing) => existing.intakeUploadId === row.intakeUploadId),
        ),
      ])
      setEligibleAttachmentsNextCursor(next.nextCursor)
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setBusy(null)
    }
  }

  async function loadMoreRequests() {
    if (!nextCursor || busy) return
    setBusy('requests')
    setError(null)
    try {
      const page = await client.support.listRequests.query({
        venueId: activeVenue.id,
        cursor: nextCursor,
      })
      setRequests((current) => [...current, ...(page.items as RequestSummary[])])
      setNextCursor(page.nextCursor)
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setBusy(null)
    }
  }

  async function loadMoreMessages() {
    if (!detail?.nextMessageCursor || busy) return
    setBusy('messages')
    setError(null)
    try {
      const next = (await client.support.getRequest.query({
        venueId: activeVenue.id,
        requestId: detail.id,
        messageCursor: detail.nextMessageCursor,
      })) as RequestDetail
      setDetail((current) =>
        current
          ? {
              ...next,
              messages: [...current.messages, ...next.messages],
            }
          : next,
      )
    } catch (loadError) {
      setError(errorText(loadError))
    } finally {
      setBusy(null)
    }
  }

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writeInFlight.current) return
    writeInFlight.current = true
    clearFeedback()
    setBusy('create')
    try {
      const created = await client.support.createRequest.mutate({
        operationId: createOperationId.current,
        venueId: activeVenue.id,
        category,
        subject,
        body: requestBody,
        attachments: createAttachments.map((intakeUploadId) => ({ intakeUploadId })),
      })
      const nextDetail: RequestDetail = {
        ...(created.request as RequestSummary),
        messages: [created.message as ClientMessage],
        nextMessageCursor: null,
      }
      setRequests((current) => [created.request as RequestSummary, ...current])
      setDetail(nextDetail)
      setSubject('')
      setRequestBody('')
      setCreateAttachments([])
      createOperationId.current = crypto.randomUUID()
      setView('conversation')
      setNotice('Your message and selected files were submitted for review. Nothing was published.')
    } catch (createError) {
      setError(writeErrorText(createError))
    } finally {
      writeInFlight.current = false
      setBusy(null)
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || writeInFlight.current) return
    writeInFlight.current = true
    clearFeedback()
    setBusy('reply')
    const submittedRequestId = detail.id
    try {
      const result = await client.support.addMessage.mutate({
        operationId: replyOperationId.current,
        venueId: activeVenue.id,
        requestId: submittedRequestId,
        expectedVersion: detail.version,
        body: replyBody,
        attachments: replyAttachments.map((intakeUploadId) => ({ intakeUploadId })),
      })
      setDetail((current) =>
        current?.id === submittedRequestId
          ? {
              ...current,
              version: result.requestVersion,
              messages: [...current.messages, result.message as ClientMessage],
            }
          : current,
      )
      setRequests((current) =>
        current.map((request) =>
          request.id === submittedRequestId
            ? { ...request, version: result.requestVersion }
            : request,
        ),
      )
      setReplyBody('')
      setReplyAttachments([])
      replyOperationId.current = crypto.randomUUID()
      setNotice('Your message and selected files were submitted for review. Nothing was published.')
    } catch (replyError) {
      setConflict(isConflict(replyError))
      setError(
        isConflict(replyError)
          ? 'Your reply was not sent because this conversation changed. Refresh it and try again; your draft is still here.'
          : writeErrorText(replyError),
      )
    } finally {
      writeInFlight.current = false
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen px-4 py-7 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 border-b border-pf-light pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-pf-primary">PathFinder Support</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-pf-deep sm:text-4xl">
              How can we help?
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-pf-deep/75">
              Ask a question or request a change. Your conversation stays here so it is easy to
              follow.
            </p>
          </div>
          {venues.length > 1 ? (
            <label className="text-sm font-medium text-pf-deep">
              Venue
              <select
                aria-label="Venue"
                value={activeVenue.id}
                disabled={busy === 'create' || busy === 'reply'}
                onChange={(event) =>
                  router.replace(`/support?venue=${encodeURIComponent(event.target.value)}`)
                }
                className="mt-2 block min-h-11 rounded-xl border border-pf-light bg-white px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
              >
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </header>

        <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,1.6fr)]">
          <aside className="rounded-3xl border border-pf-light bg-white p-4 shadow-sm">
            <button
              type="button"
              disabled={busy === 'create' || busy === 'reply'}
              onClick={() => {
                clearFeedback()
                setView('create')
              }}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-pf-primary px-4 text-sm font-semibold text-white hover:bg-pf-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent focus-visible:ring-offset-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> New request
            </button>

            <h2 className="mt-6 px-2 text-xs font-semibold uppercase tracking-[0.16em] text-pf-deep/55">
              Conversations
            </h2>
            {requests.length === 0 ? (
              <p className="px-2 py-8 text-sm leading-6 text-pf-deep/65">
                You have no support conversations yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-1">
                {requests.map((request) => (
                  <li key={request.id}>
                    <button
                      type="button"
                      disabled={busy === 'create' || busy === 'reply'}
                      onClick={() => void openRequest(request.id)}
                      aria-current={view === 'conversation' && detail?.id === request.id}
                      className={`flex min-h-16 w-full items-center gap-3 rounded-xl px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent ${
                        view === 'conversation' && detail?.id === request.id
                          ? 'bg-pf-primary/[0.07]'
                          : 'hover:bg-pf-surface'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-pf-deep">
                          {request.subject}
                        </span>
                        <span className="mt-1 block text-xs text-pf-deep/60">
                          {statusLabels[request.status] ?? 'In progress'} ·{' '}
                          {dateLabel(request.updatedAt)}
                        </span>
                      </span>
                      <ChevronRight
                        className="h-4 w-4 shrink-0 text-pf-deep/40"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {nextCursor ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void loadMoreRequests()}
                className="mt-3 min-h-11 w-full rounded-xl text-sm font-semibold text-pf-primary hover:bg-pf-surface disabled:opacity-50"
              >
                {busy === 'requests' ? 'Loading…' : 'Load more'}
              </button>
            ) : null}
          </aside>

          <section className="min-h-[30rem] rounded-3xl border border-pf-light bg-white p-5 shadow-sm sm:p-7">
            {error ? (
              <div
                role="alert"
                className="mb-5 flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-800"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{error}</span>
                {conflict && detail ? (
                  <button
                    type="button"
                    onClick={() => void openRequest(detail.id)}
                    className="ml-auto shrink-0 font-semibold underline underline-offset-2"
                  >
                    Refresh
                  </button>
                ) : null}
              </div>
            ) : null}
            {notice ? (
              <p
                role="status"
                className="mb-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
              >
                {notice}
              </p>
            ) : null}

            {busy === 'detail' ? (
              <div
                role="status"
                className="flex min-h-64 items-center justify-center gap-2 text-sm text-pf-deep/65"
              >
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Opening conversation…
              </div>
            ) : view === 'create' ? (
              <form onSubmit={createRequest} className="mx-auto max-w-2xl space-y-5">
                <div>
                  <p className="text-sm font-medium text-pf-primary">New request</p>
                  <h2 className="mt-1 text-2xl font-semibold text-pf-deep">
                    Tell us what you need
                  </h2>
                </div>
                <label className="block text-sm font-medium text-pf-deep">
                  What is this about?
                  <select
                    value={category}
                    disabled={busy === 'create'}
                    onChange={(event) =>
                      changeCreateDraft(() =>
                        setCategory(event.target.value as (typeof categories)[number][0]),
                      )
                    }
                    className="mt-2 block min-h-12 w-full rounded-xl border border-pf-light bg-white px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                  >
                    {categories.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm font-medium text-pf-deep">
                  Subject
                  <input
                    required
                    maxLength={200}
                    value={subject}
                    disabled={busy === 'create'}
                    onChange={(event) => changeCreateDraft(() => setSubject(event.target.value))}
                    className="mt-2 block min-h-12 w-full rounded-xl border border-pf-light px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                  />
                </label>
                <label className="block text-sm font-medium text-pf-deep">
                  Message
                  <textarea
                    required
                    maxLength={20_000}
                    rows={7}
                    value={requestBody}
                    disabled={busy === 'create'}
                    onChange={(event) =>
                      changeCreateDraft(() => setRequestBody(event.target.value))
                    }
                    className="mt-2 block w-full rounded-xl border border-pf-light px-4 py-3 leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                    placeholder="Share the change, question, or information you would like us to review."
                  />
                </label>
                <AttachmentPicker
                  available={eligibleAttachments}
                  selected={createAttachments}
                  disabled={busy === 'create'}
                  label="Files for PathFinder review (optional)"
                  onChange={(ids) => changeCreateDraft(() => setCreateAttachments(ids))}
                />
                {eligibleAttachmentsNextCursor ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void loadMoreEligibleAttachments()}
                    className="min-h-11 rounded-xl border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                  >
                    {busy === 'attachments' ? 'Loading files…' : 'Show more recent files'}
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={busy !== null}
                  className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white hover:bg-pf-accent disabled:opacity-50"
                >
                  {busy === 'create' ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                  {busy === 'create' ? 'Sending…' : 'Send request'}
                </button>
              </form>
            ) : detail ? (
              <div className="flex min-h-[28rem] flex-col">
                <div className="border-b border-pf-light pb-5">
                  <button
                    type="button"
                    onClick={() => setView('create')}
                    className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-pf-primary lg:hidden"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" /> New request
                  </button>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-2xl font-semibold text-pf-deep">{detail.subject}</h2>
                      <p className="mt-2 text-sm text-pf-deep/65">
                        {statusLabels[detail.status] ?? 'In progress'}
                      </p>
                    </div>
                    <span className="rounded-full bg-pf-surface px-3 py-1.5 text-xs font-semibold text-pf-primary">
                      {activeVenue.name}
                    </span>
                  </div>
                </div>

                <div className="flex-1 space-y-4 py-6" aria-live="polite">
                  {detail.messages
                    .filter((message) => message.visibility === 'CLIENT_VISIBLE')
                    .map((message) => {
                      const fromClient = message.authorKind === 'CLIENT'
                      return (
                        <article
                          key={message.id}
                          className={`max-w-[92%] rounded-2xl px-4 py-3 sm:max-w-[78%] ${
                            fromClient
                              ? 'ml-auto bg-pf-primary text-white'
                              : 'border border-pf-light bg-pf-surface text-pf-deep'
                          }`}
                        >
                          <p className="text-xs font-semibold opacity-75">
                            {fromClient ? 'You' : 'PathFinder Support'} ·{' '}
                            {dateLabel(message.createdAt)}
                          </p>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6">
                            {message.body}
                          </p>
                          {message.attachments.length > 0 ? (
                            <ul className="mt-3 space-y-1 text-xs">
                              {message.attachments.map((attachment) => (
                                <li key={attachment.id}>{attachment.filename}</li>
                              ))}
                            </ul>
                          ) : null}
                        </article>
                      )
                    })}
                  {detail.nextMessageCursor ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void loadMoreMessages()}
                      className="min-h-11 text-sm font-semibold text-pf-primary disabled:opacity-50"
                    >
                      {busy === 'messages' ? 'Loading…' : 'Load more messages'}
                    </button>
                  ) : null}
                </div>

                {detail.status === 'COMPLETED' || detail.status === 'CANCELLED' ? (
                  <p className="rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/70">
                    This conversation is closed. Start a new request if you need anything else.
                  </p>
                ) : (
                  <form onSubmit={sendReply} className="border-t border-pf-light pt-5">
                    <label className="sr-only" htmlFor="support-reply">
                      Reply
                    </label>
                    <textarea
                      id="support-reply"
                      required
                      rows={4}
                      maxLength={20_000}
                      value={replyBody}
                      disabled={busy === 'reply'}
                      onChange={(event) => {
                        changeReplyDraft(() => setReplyBody(event.target.value))
                        if (!writeInFlight.current) clearFeedback()
                      }}
                      placeholder="Write a reply…"
                      className="block w-full rounded-xl border border-pf-light px-4 py-3 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pf-accent"
                    />
                    <div className="mt-4">
                      <AttachmentPicker
                        available={eligibleAttachments}
                        selected={replyAttachments}
                        disabled={busy === 'reply'}
                        label="Files for PathFinder review (optional)"
                        onChange={(ids) => changeReplyDraft(() => setReplyAttachments(ids))}
                      />
                      {eligibleAttachmentsNextCursor ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void loadMoreEligibleAttachments()}
                          className="mt-3 min-h-11 rounded-xl border border-pf-light px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                        >
                          {busy === 'attachments' ? 'Loading files…' : 'Show more recent files'}
                        </button>
                      ) : null}
                    </div>
                    <div className="mt-3 flex justify-end">
                      <button
                        type="submit"
                        disabled={busy !== null}
                        className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-pf-primary px-5 text-sm font-semibold text-white hover:bg-pf-accent disabled:opacity-50"
                      >
                        {busy === 'reply' ? 'Sending…' : 'Send reply'}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center text-center">
                <MessageCircle className="h-8 w-8 text-pf-primary" aria-hidden="true" />
                <h2 className="mt-4 text-xl font-semibold text-pf-deep">Choose a conversation</h2>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
