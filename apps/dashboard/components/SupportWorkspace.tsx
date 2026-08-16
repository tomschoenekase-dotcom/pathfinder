'use client'

import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
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
  clientVersion: number
  clientActivityAt: Date | string
  requesterIsCurrentUser: boolean
  participantIsCurrentUser: boolean
  canReply: boolean
  statusChangedAt: Date | string
  createdAt: Date | string
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
  authorIsCurrentUser: boolean
  body: string
  createdAt: Date | string
  attachments: Attachment[]
}
type RequestDetail = RequestSummary & {
  messages: ClientMessage[]
  nextMessageCursor: { createdAt: string; id: string } | null
}
type ParticipantCandidate = { userId: string; displayLabel: string; activeOnRequest: boolean }

type SupportWorkspaceProps = {
  venues: VenueOption[]
  activeVenue: VenueOption
  initialRequests: RequestSummary[]
  initialNextCursor: { clientActivityAt: string; id: string } | null
  initialDetail: RequestDetail | null
  initialEligibleAttachments: EligibleAttachment[]
  initialEligibleAttachmentsNextCursor: EligibleAttachmentCursor | null
}

const categories = [
  ['GENERAL', 'General question'],
  ['CONTENT_CORRECTION', 'Correct visitor information'],
  ['OPERATIONAL_UPDATE', 'Temporary visitor update'],
  ['BRANDING', 'Branding or appearance'],
  ['EXPERIENCE_BEHAVIOR', 'Torchico behavior'],
  ['ACCESSIBILITY', 'Accessibility'],
] as const

const statusLabels: Record<string, string> = {
  OPEN: 'Received',
  WAITING_FOR_CLIENT: 'Waiting for your reply',
  IN_REVIEW: 'In review',
  PATCH_DRAFTED: 'Preparing an update',
  VALIDATING: 'Checking the update',
  AWAITING_APPROVAL: 'Awaiting approval',
  APPLYING: 'Updating Torchico',
  COMPLETED: 'Completed',
  CANCELLED: 'Closed',
}

function dateLabel(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}

function errorText(error: unknown) {
  if (isConflict(error)) return 'This conversation changed. Refresh it before trying again.'
  return 'We could not load that support information. Please try again.'
}

function writeErrorText() {
  return 'We could not confirm that your message was sent. Your draft is still here.'
}

function isConflict(error: unknown) {
  return (
    (error as { data?: { code?: unknown } } | null)?.data?.code === 'CONFLICT' ||
    (error as { shape?: { data?: { code?: unknown } } } | null)?.shape?.data?.code === 'CONFLICT'
  )
}

function isNotFound(error: unknown) {
  return (
    (error as { data?: { code?: unknown } } | null)?.data?.code === 'NOT_FOUND' ||
    (error as { shape?: { data?: { code?: unknown } } } | null)?.shape?.data?.code === 'NOT_FOUND'
  )
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isSafeClientMessage(message: ClientMessage) {
  const visibility = (message as ClientMessage & { visibility?: unknown }).visibility
  return visibility !== 'INTERNAL' && visibility !== 'INTERNAL_ONLY'
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
        Choose a file you already shared after its required checks are complete. Torchico still
        reviews every file before using it; attaching a file here never publishes it. Files cannot
        be previewed or downloaded from Support.
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
        <p className="mt-3 text-sm text-pf-deep/70">
          No recent files have completed the required checks.
        </p>
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
                  {row.mimeType} · {fileSize(row.byteSize)} · Shared for review
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
  const scopeRef = useRef(activeVenue.id)
  scopeRef.current = activeVenue.id
  const writeGeneration = useRef(0)
  const detailRequestRef = useRef(initialDetail?.id ?? null)
  const detailReadGeneration = useRef(0)
  const requestReadGeneration = useRef(0)
  const attachmentReadGeneration = useRef(0)
  const messageReadInFlight = useRef(false)
  const requestReadInFlight = useRef(false)
  const attachmentReadInFlight = useRef(false)
  const nextBusyOwner = useRef(0)
  const activeBusyOwner = useRef<number | null>(null)
  const createOperationId = useRef(crypto.randomUUID())
  const replyOperationId = useRef(crypto.randomUUID())
  const participantOperation = useRef({ key: '', id: crypto.randomUUID() })
  const [participantCandidates, setParticipantCandidates] = useState<ParticipantCandidate[] | null>(
    null,
  )
  const [participantNextCursor, setParticipantNextCursor] = useState<string | null>(null)
  const participantReadGeneration = useRef(0)
  const participantReadInFlight = useRef(false)
  const participantAuthorityRef = useRef({
    id: detail?.id ?? null,
    clientVersion: detail?.clientVersion ?? null,
    requesterIsCurrentUser: detail?.requesterIsCurrentUser ?? false,
  })
  const nextParticipantAuthority = {
    id: detail?.id ?? null,
    clientVersion: detail?.clientVersion ?? null,
    requesterIsCurrentUser: detail?.requesterIsCurrentUser ?? false,
  }
  if (
    participantAuthorityRef.current.id !== nextParticipantAuthority.id ||
    participantAuthorityRef.current.clientVersion !== nextParticipantAuthority.clientVersion ||
    participantAuthorityRef.current.requesterIsCurrentUser !==
      nextParticipantAuthority.requesterIsCurrentUser
  ) {
    participantReadGeneration.current += 1
    participantReadInFlight.current = false
    participantAuthorityRef.current = nextParticipantAuthority
    if (participantCandidates !== null) setParticipantCandidates(null)
    if (participantNextCursor !== null) setParticipantNextCursor(null)
  }

  useEffect(() => {
    scopeRef.current = activeVenue.id
    detailReadGeneration.current += 1
    requestReadGeneration.current += 1
    attachmentReadGeneration.current += 1
    writeGeneration.current += 1
    detailRequestRef.current = initialDetail?.id ?? null
    messageReadInFlight.current = false
    requestReadInFlight.current = false
    attachmentReadInFlight.current = false
    writeInFlight.current = false
    activeBusyOwner.current = null
    setBusy(null)
    setRequests(initialRequests)
    setNextCursor(initialNextCursor)
    setDetail(initialDetail)
    setEligibleAttachments(initialEligibleAttachments)
    setEligibleAttachmentsNextCursor(initialEligibleAttachmentsNextCursor)
    setView(initialDetail ? 'conversation' : 'create')
    setSubject('')
    setCategory('GENERAL')
    setRequestBody('')
    setCreateAttachments([])
    setReplyBody('')
    setReplyAttachments([])
    createOperationId.current = crypto.randomUUID()
    replyOperationId.current = crypto.randomUUID()
    participantOperation.current = { key: '', id: crypto.randomUUID() }
    participantReadGeneration.current += 1
    participantReadInFlight.current = false
    setParticipantCandidates(null)
    setParticipantNextCursor(null)
    setNotice(null)
    setError(null)
    setConflict(false)
  }, [
    activeVenue.id,
    initialDetail,
    initialEligibleAttachments,
    initialEligibleAttachmentsNextCursor,
    initialNextCursor,
    initialRequests,
  ])

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

  function startBusy(kind: string) {
    const owner = ++nextBusyOwner.current
    activeBusyOwner.current = owner
    setBusy(kind)
    return owner
  }

  function finishBusy(owner: number) {
    if (activeBusyOwner.current !== owner) return
    activeBusyOwner.current = null
    setBusy(null)
  }

  function purgeRequest(requestId: string) {
    detailReadGeneration.current += 1
    detailRequestRef.current = null
    messageReadInFlight.current = false
    setDetail(null)
    setRequests((current) => current.filter((request) => request.id !== requestId))
    setReplyBody('')
    setReplyAttachments([])
    replyOperationId.current = crypto.randomUUID()
    setView('conversation')
    setConflict(false)
    setError('This conversation is not available.')
  }

  async function openRequest(requestId: string) {
    if (writeInFlight.current) return
    const scope = activeVenue.id
    const generation = ++detailReadGeneration.current
    detailRequestRef.current = requestId
    messageReadInFlight.current = false
    clearFeedback()
    const busyOwner = startBusy('detail')
    try {
      const next = await client.support.getRequest.query({
        venueId: activeVenue.id,
        requestId,
      })
      if (
        scopeRef.current !== scope ||
        detailReadGeneration.current !== generation ||
        detailRequestRef.current !== requestId
      )
        return
      if (
        detail?.id !== requestId ||
        !next.canReply ||
        next.status === 'COMPLETED' ||
        next.status === 'CANCELLED'
      ) {
        setReplyBody('')
        setReplyAttachments([])
      }
      setDetail(next as RequestDetail)
      replyOperationId.current = crypto.randomUUID()
      setView('conversation')
    } catch (loadError) {
      if (
        scopeRef.current !== scope ||
        detailReadGeneration.current !== generation ||
        detailRequestRef.current !== requestId
      )
        return
      if (isNotFound(loadError)) {
        purgeRequest(requestId)
      } else {
        detailRequestRef.current = detail?.id ?? null
        setError(errorText(loadError))
      }
    } finally {
      finishBusy(busyOwner)
    }
  }

  async function loadMoreEligibleAttachments() {
    if (!eligibleAttachmentsNextCursor || busy || attachmentReadInFlight.current) return
    attachmentReadInFlight.current = true
    const scope = activeVenue.id
    const cursor = eligibleAttachmentsNextCursor
    const generation = ++attachmentReadGeneration.current
    clearFeedback()
    const busyOwner = startBusy('attachments')
    try {
      const next = await client.support.listEligibleAttachments.query({
        venueId: activeVenue.id,
        limit: 20,
        cursor,
      })
      if (scopeRef.current !== scope || attachmentReadGeneration.current !== generation) return
      setEligibleAttachments((current) => [
        ...current,
        ...next.items.filter(
          (row) => !current.some((existing) => existing.intakeUploadId === row.intakeUploadId),
        ),
      ])
      setEligibleAttachmentsNextCursor(next.nextCursor)
    } catch (loadError) {
      if (scopeRef.current === scope && attachmentReadGeneration.current === generation)
        setError(errorText(loadError))
    } finally {
      if (scopeRef.current === scope && attachmentReadGeneration.current === generation)
        attachmentReadInFlight.current = false
      finishBusy(busyOwner)
    }
  }

  async function loadMoreRequests() {
    if (!nextCursor || busy || requestReadInFlight.current) return
    requestReadInFlight.current = true
    const scope = activeVenue.id
    const cursor = nextCursor
    const generation = ++requestReadGeneration.current
    const busyOwner = startBusy('requests')
    setError(null)
    try {
      const page = await client.support.listRequests.query({
        venueId: activeVenue.id,
        cursor,
      })
      if (scopeRef.current !== scope || requestReadGeneration.current !== generation) return
      setRequests((current) => [
        ...current,
        ...(page.items as RequestSummary[]).filter(
          (row) => !current.some((existing) => existing.id === row.id),
        ),
      ])
      setNextCursor(page.nextCursor)
    } catch (loadError) {
      if (scopeRef.current === scope && requestReadGeneration.current === generation)
        setError(errorText(loadError))
    } finally {
      if (scopeRef.current === scope && requestReadGeneration.current === generation) {
        requestReadInFlight.current = false
      }
      finishBusy(busyOwner)
    }
  }

  async function loadMoreMessages() {
    if (!detail?.nextMessageCursor || busy || messageReadInFlight.current) return
    messageReadInFlight.current = true
    const scope = activeVenue.id
    const requestId = detail.id
    const cursor = detail.nextMessageCursor
    const generation = detailReadGeneration.current
    const busyOwner = startBusy('messages')
    setError(null)
    try {
      const next = (await client.support.getRequest.query({
        venueId: activeVenue.id,
        requestId,
        messageCursor: cursor,
      })) as RequestDetail
      if (
        scopeRef.current !== scope ||
        detailReadGeneration.current !== generation ||
        detailRequestRef.current !== requestId ||
        next.id !== requestId
      )
        return
      setDetail((current) =>
        current?.id === requestId
          ? {
              ...next,
              messages: [
                ...current.messages,
                ...next.messages.filter(
                  (message) => !current.messages.some((existing) => existing.id === message.id),
                ),
              ],
            }
          : current,
      )
    } catch (loadError) {
      if (
        scopeRef.current === scope &&
        detailReadGeneration.current === generation &&
        detailRequestRef.current === requestId
      ) {
        if (isNotFound(loadError)) purgeRequest(requestId)
        else setError(errorText(loadError))
      }
    } finally {
      if (
        scopeRef.current === scope &&
        detailReadGeneration.current === generation &&
        detailRequestRef.current === requestId
      ) {
        messageReadInFlight.current = false
      }
      finishBusy(busyOwner)
    }
  }

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writeInFlight.current) return
    writeInFlight.current = true
    const submittedScope = activeVenue.id
    const generation = ++writeGeneration.current
    clearFeedback()
    const busyOwner = startBusy('create')
    try {
      const created = await client.support.createRequest.mutate({
        operationId: createOperationId.current,
        venueId: activeVenue.id,
        category,
        subject,
        body: requestBody,
        attachments: createAttachments.map((intakeUploadId) => ({ intakeUploadId })),
      })
      if (scopeRef.current !== submittedScope || writeGeneration.current !== generation) return
      const nextDetail: RequestDetail = {
        ...(created.request as RequestSummary),
        messages: [created.message as ClientMessage],
        nextMessageCursor: null,
      }
      setRequests((current) => [
        created.request as RequestSummary,
        ...current.filter((request) => request.id !== created.request.id),
      ])
      setDetail(nextDetail)
      detailRequestRef.current = nextDetail.id
      setSubject('')
      setRequestBody('')
      setCreateAttachments([])
      createOperationId.current = crypto.randomUUID()
      setView('conversation')
      setNotice('Your message and selected files were submitted for review. Nothing was published.')
    } catch {
      if (scopeRef.current === submittedScope && writeGeneration.current === generation)
        setError(writeErrorText())
    } finally {
      if (scopeRef.current === submittedScope && writeGeneration.current === generation) {
        writeInFlight.current = false
        finishBusy(busyOwner)
      }
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || !detail.canReply || writeInFlight.current) return
    writeInFlight.current = true
    const submittedScope = activeVenue.id
    const generation = ++writeGeneration.current
    clearFeedback()
    const busyOwner = startBusy('reply')
    const submittedRequestId = detail.id
    try {
      const respondingToInformation =
        detail.status === 'WAITING_FOR_CLIENT' && detail.missingInformation.length > 0
      const result: {
        message: ClientMessage
        clientVersion: number
        status?: string
        missingInformation?: string[]
      } = await (respondingToInformation
        ? client.support.respondToInformation.mutate({
            operationId: replyOperationId.current,
            venueId: activeVenue.id,
            requestId: submittedRequestId,
            expectedClientVersion: detail.clientVersion,
            body: replyBody,
            attachments: replyAttachments.map((intakeUploadId) => ({ intakeUploadId })),
          })
        : client.support.addMessage.mutate({
            operationId: replyOperationId.current,
            venueId: activeVenue.id,
            requestId: submittedRequestId,
            expectedClientVersion: detail.clientVersion,
            body: replyBody,
            attachments: replyAttachments.map((intakeUploadId) => ({ intakeUploadId })),
          }))
      if (scopeRef.current !== submittedScope || writeGeneration.current !== generation) return
      setDetail((current) =>
        current?.id === submittedRequestId
          ? {
              ...current,
              clientVersion: result.clientVersion,
              ...(result.status && result.missingInformation
                ? { status: result.status, missingInformation: result.missingInformation }
                : {}),
              messages: [...current.messages, result.message as ClientMessage],
            }
          : current,
      )
      setRequests((current) =>
        current.map((request) =>
          request.id === submittedRequestId
            ? {
                ...request,
                clientVersion: result.clientVersion,
                ...(result.status && result.missingInformation
                  ? { status: result.status, missingInformation: result.missingInformation }
                  : {}),
              }
            : request,
        ),
      )
      setReplyBody('')
      setReplyAttachments([])
      replyOperationId.current = crypto.randomUUID()
      setNotice('Your message and selected files were submitted for review. Nothing was published.')
    } catch (replyError) {
      if (scopeRef.current !== submittedScope || writeGeneration.current !== generation) return
      if (isNotFound(replyError)) {
        purgeRequest(submittedRequestId)
        return
      }
      setConflict(isConflict(replyError))
      setError(
        isConflict(replyError)
          ? 'Your reply was not sent because this conversation changed. Refresh it and try again; your draft is still here.'
          : writeErrorText(),
      )
    } finally {
      if (scopeRef.current === submittedScope && writeGeneration.current === generation) {
        writeInFlight.current = false
        finishBusy(busyOwner)
      }
    }
  }

  async function loadParticipantCandidates(cursor?: string) {
    if (!detail?.requesterIsCurrentUser || writeInFlight.current || participantReadInFlight.current)
      return
    participantReadInFlight.current = true
    const scope = activeVenue.id
    const requestId = detail.id
    const clientVersion = detail.clientVersion
    const generation = ++participantReadGeneration.current
    const busyOwner = startBusy('participants')
    try {
      const result = await client.support.listParticipantCandidates.query({
        venueId: scope,
        requestId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      })
      if (
        scopeRef.current !== scope ||
        participantReadGeneration.current !== generation ||
        detailRequestRef.current !== requestId ||
        participantAuthorityRef.current.id !== requestId ||
        participantAuthorityRef.current.clientVersion !== clientVersion ||
        !participantAuthorityRef.current.requesterIsCurrentUser
      )
        return
      setParticipantCandidates((current) =>
        cursor && current
          ? [
              ...current,
              ...result.candidates.filter(
                (row) => !current.some((item) => item.userId === row.userId),
              ),
            ]
          : result.candidates,
      )
      setParticipantNextCursor(result.nextCursor)
    } catch (loadError) {
      if (
        scopeRef.current !== scope ||
        participantReadGeneration.current !== generation ||
        participantAuthorityRef.current.id !== requestId ||
        participantAuthorityRef.current.clientVersion !== clientVersion ||
        !participantAuthorityRef.current.requesterIsCurrentUser
      )
        return
      if (isNotFound(loadError)) purgeRequest(requestId)
      else setError(errorText(loadError))
    } finally {
      if (participantReadGeneration.current === generation) participantReadInFlight.current = false
      finishBusy(busyOwner)
    }
  }

  async function changeParticipant(candidate: ParticipantCandidate) {
    if (!detail?.requesterIsCurrentUser || writeInFlight.current) return
    writeInFlight.current = true
    const scope = activeVenue.id
    const requestId = detail.id
    const generation = ++writeGeneration.current
    const busyOwner = startBusy('participant-write')
    let confirmed = false
    clearFeedback()
    try {
      const operationKey = `${candidate.activeOnRequest ? 'revoke' : 'grant'}:${candidate.userId}:${detail.clientVersion}`
      if (participantOperation.current.key !== operationKey)
        participantOperation.current = { key: operationKey, id: crypto.randomUUID() }
      const mutation = candidate.activeOnRequest
        ? client.support.revokeParticipant
        : client.support.grantParticipant
      await mutation.mutate({
        operationId: participantOperation.current.id,
        venueId: scope,
        requestId,
        userId: candidate.userId,
        expectedClientVersion: detail.clientVersion,
      })
      if (scopeRef.current !== scope || writeGeneration.current !== generation) return
      participantReadGeneration.current += 1
      confirmed = true
      setParticipantCandidates(null)
      setNotice(
        'Team access changed. This conversation is refreshing before more actions can be taken.',
      )
      router.refresh()
    } catch (mutationError) {
      if (scopeRef.current !== scope || writeGeneration.current !== generation) return
      if (isNotFound(mutationError)) purgeRequest(requestId)
      else {
        setConflict(isConflict(mutationError))
        setError(
          isConflict(mutationError)
            ? 'Team access was not changed because this conversation changed. Refresh before retrying.'
            : 'We could not confirm whether team access changed. Retry uses the same request identity.',
        )
      }
    } finally {
      if (!confirmed && scopeRef.current === scope && writeGeneration.current === generation) {
        writeInFlight.current = false
        finishBusy(busyOwner)
      }
    }
  }

  return (
    <div className="min-h-screen px-4 py-7 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 border-b border-pf-light pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium text-pf-primary">Torchico Support</p>
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
                onChange={(event) => {
                  if (writeInFlight.current) return
                  detailReadGeneration.current += 1
                  requestReadGeneration.current += 1
                  attachmentReadGeneration.current += 1
                  router.replace(`/support?venue=${encodeURIComponent(event.target.value)}`)
                }}
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
                if (writeInFlight.current) return
                detailReadGeneration.current += 1
                detailRequestRef.current = null
                setReplyBody('')
                setReplyAttachments([])
                replyOperationId.current = crypto.randomUUID()
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
                          {dateLabel(request.clientActivityAt)}
                          {!request.requesterIsCurrentUser ? ' · Your team' : ''}
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
                  label="Files for Torchico review (optional)"
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

                {detail.canReply &&
                detail.missingInformation.length > 0 &&
                detail.status !== 'COMPLETED' &&
                detail.status !== 'CANCELLED' ? (
                  <section
                    aria-labelledby="support-information-needed"
                    className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-800">
                      Your next step
                    </p>
                    <h3
                      id="support-information-needed"
                      className="mt-1 text-lg font-semibold text-amber-950"
                    >
                      A few details will help us continue
                    </h3>
                    <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-6 text-amber-950/85">
                      {detail.missingInformation.slice(0, 5).map((item, index) => (
                        <li key={`${index}:${item}`}>{item}</li>
                      ))}
                      {detail.missingInformation.length > 5 ? (
                        <li>{detail.missingInformation.length - 5} more details in this request</li>
                      ) : null}
                    </ul>
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
                      <a
                        href="#support-reply"
                        className="inline-flex min-h-11 items-center rounded-xl bg-amber-900 px-4 font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2"
                      >
                        Reply with details
                      </a>
                      <a
                        href={`/venues/${encodeURIComponent(activeVenue.id)}/intake`}
                        className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-amber-900 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
                      >
                        Share a file or website
                      </a>
                    </div>
                  </section>
                ) : null}

                <div className="flex-1 space-y-4 py-6" aria-live="polite">
                  {detail.messages.filter(isSafeClientMessage).map((message) => {
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
                          {fromClient
                            ? message.authorIsCurrentUser
                              ? 'You'
                              : 'Your team'
                            : 'Torchico Support'}{' '}
                          · {dateLabel(message.createdAt)}
                        </p>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{message.body}</p>
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

                {detail.requesterIsCurrentUser ? (
                  <section
                    className="border-t border-pf-light py-5"
                    aria-labelledby="support-team-heading"
                  >
                    <h3 id="support-team-heading" className="font-semibold text-pf-deep">
                      Conversation access
                    </h3>
                    <p className="mt-1 text-sm text-pf-deep/65">
                      Choose active members of your organization who may read and reply to this
                      conversation.
                    </p>
                    {participantCandidates === null ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void loadParticipantCandidates()}
                        className="mt-3 min-h-11 rounded-xl border border-pf-primary px-4 text-sm font-semibold text-pf-primary disabled:opacity-50"
                      >
                        {busy === 'participants' ? 'Loading…' : 'Manage team access'}
                      </button>
                    ) : participantCandidates.length === 0 ? (
                      <p className="mt-3 text-sm text-pf-deep/65">
                        No other active team members are available.
                      </p>
                    ) : (
                      <ul className="mt-3 divide-y divide-pf-light rounded-2xl border border-pf-light">
                        {participantCandidates.map((candidate) => (
                          <li
                            key={candidate.userId}
                            className="flex items-center justify-between gap-3 p-3"
                          >
                            <span className="text-sm font-medium text-pf-deep">
                              {candidate.displayLabel}
                            </span>
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void changeParticipant(candidate)}
                              className="min-h-11 rounded-xl px-3 text-sm font-semibold text-pf-primary disabled:opacity-50"
                            >
                              {candidate.activeOnRequest ? 'Remove access' : 'Give access'}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {participantNextCursor ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void loadParticipantCandidates(participantNextCursor)}
                        className="mt-3 min-h-11 text-sm font-semibold text-pf-primary disabled:opacity-50"
                      >
                        Show more team members
                      </button>
                    ) : null}
                  </section>
                ) : null}

                {!detail.canReply ||
                detail.status === 'COMPLETED' ||
                detail.status === 'CANCELLED' ? (
                  <p className="rounded-2xl bg-pf-surface p-4 text-sm text-pf-deep/70">
                    {detail.status === 'COMPLETED' || detail.status === 'CANCELLED'
                      ? 'This conversation is closed. Start a new request if you need anything else.'
                      : 'You no longer have access to reply to this conversation.'}
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
                        label="Files for Torchico review (optional)"
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
