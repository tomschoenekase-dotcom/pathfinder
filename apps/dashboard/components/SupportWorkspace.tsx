'use client'

import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Paperclip,
  Plus,
  Users,
} from 'lucide-react'

import { useTRPCClient } from '../lib/trpc'
import { browserUuid } from '../lib/browser-uuid'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { supportStatusLabel } from '../lib/support-status'
import { useIntakeTransferApi } from '../lib/use-intake-transfer-api'
import {
  attachmentsBlockSending,
  ComposerAttachments,
  readyAttachmentIds,
  type ComposerAttachment,
} from './portal/ComposerAttachments'
import {
  PortalNotice,
  PortalPage,
  portalButtonPrimary,
  portalButtonSecondary,
  portalFocus,
  portalInput,
  portalTextLink,
} from './portal/PortalPrimitives'
import {
  SupportCompletionOutcome,
  type SupportCompletionOutcomeValue,
} from './SupportCompletionOutcome'

const SUPPORT_READ_TIMEOUT_MS = 15_000

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
  completionOutcome?: SupportCompletionOutcomeValue | null
}
type RequestDetail = RequestSummary & {
  messages: ClientMessage[]
  nextMessageCursor: { createdAt: string; id: string } | null
}
type ParticipantCandidate = { userId: string; displayLabel: string; activeOnRequest: boolean }
type SupportCategory =
  | 'GENERAL'
  | 'CONTENT_CORRECTION'
  | 'OPERATIONAL_UPDATE'
  | 'BRANDING'
  | 'EXPERIENCE_BEHAVIOR'
  | 'ACCESSIBILITY'

type SupportWorkspaceProps = {
  venues: VenueOption[]
  activeVenue: VenueOption
  initialRequests: RequestSummary[]
  initialNextCursor: { clientActivityAt: string; id: string } | null
  initialDetail: RequestDetail | null
  initialEligibleAttachments: EligibleAttachment[]
  initialEligibleAttachmentsNextCursor: EligibleAttachmentCursor | null
  operatorSupportHref?: string | undefined
  returnHref?: string | undefined
  initialCreateDraft?: {
    category: SupportCategory
    subject: string
  }
}

const categories = [
  ['GENERAL', 'General question'],
  ['CONTENT_CORRECTION', 'Correct visitor information'],
  ['OPERATIONAL_UPDATE', 'Temporary visitor update'],
  ['BRANDING', 'Branding or appearance'],
  ['EXPERIENCE_BEHAVIOR', 'Torchiko behavior'],
  ['ACCESSIBILITY', 'Accessibility'],
] as const

function dateLabel(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  )
}

function timeLabel(value: Date | string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function initials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean)
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('') || 'Y'
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

function isSafeClientMessage(message: ClientMessage) {
  const visibility = (message as ClientMessage & { visibility?: unknown }).visibility
  return visibility !== 'INTERNAL' && visibility !== 'INTERNAL_ONLY'
}

export function SupportWorkspace({
  venues,
  activeVenue,
  initialRequests,
  initialNextCursor,
  initialDetail,
  initialEligibleAttachments,
  initialEligibleAttachmentsNextCursor,
  returnHref,
  operatorSupportHref,
  initialCreateDraft,
}: SupportWorkspaceProps) {
  const router = useRouter()
  const client = useTRPCClient()
  const initialCreateCategory = initialCreateDraft?.category
  const initialCreateSubject = initialCreateDraft?.subject
  const shouldOpenCreateDraft = initialCreateDraft !== undefined
  const [requests, setRequests] = useState(initialRequests)
  const [nextCursor, setNextCursor] = useState(initialNextCursor)
  const [detail, setDetail] = useState(initialDetail)
  const [view, setView] = useState<'conversation' | 'create'>(
    shouldOpenCreateDraft ? 'create' : initialDetail ? 'conversation' : 'create',
  )
  const [subject, setSubject] = useState(initialCreateSubject ?? '')
  const [category, setCategory] = useState<SupportCategory>(initialCreateCategory ?? 'GENERAL')
  const [requestBody, setRequestBody] = useState('')
  const [replyBody, setReplyBody] = useState('')
  const [createFiles, setCreateFiles] = useState<ComposerAttachment[]>([])
  const [replyFiles, setReplyFiles] = useState<ComposerAttachment[]>([])
  const transferApi = useIntakeTransferApi()
  const [mobilePane, setMobilePane] = useState<'list' | 'conversation'>(
    initialDetail || shouldOpenCreateDraft ? 'conversation' : 'list',
  )
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
  const detailReadAbort = useRef<AbortController | null>(null)
  const requestReadAbort = useRef<AbortController | null>(null)
  const attachmentReadAbort = useRef<AbortController | null>(null)
  const messageReadInFlight = useRef(false)
  const requestReadInFlight = useRef(false)
  const attachmentReadInFlight = useRef(false)
  const nextBusyOwner = useRef(0)
  const activeBusyOwner = useRef<number | null>(null)
  const createOperationId = useRef(browserUuid())
  const replyOperationId = useRef(browserUuid())
  const participantOperation = useRef({ key: '', id: browserUuid() })
  const [participantCandidates, setParticipantCandidates] = useState<ParticipantCandidate[] | null>(
    null,
  )
  const [participantNextCursor, setParticipantNextCursor] = useState<string | null>(null)
  const participantReadGeneration = useRef(0)
  const participantReadInFlight = useRef(false)
  const participantReadAbort = useRef<AbortController | null>(null)
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
    participantReadAbort.current?.abort()
    participantReadAbort.current = null
    participantReadGeneration.current += 1
    participantReadInFlight.current = false
    participantAuthorityRef.current = nextParticipantAuthority
    if (participantCandidates !== null) setParticipantCandidates(null)
    if (participantNextCursor !== null) setParticipantNextCursor(null)
  }

  useEffect(() => {
    detailReadAbort.current?.abort()
    requestReadAbort.current?.abort()
    attachmentReadAbort.current?.abort()
    participantReadAbort.current?.abort()
    detailReadAbort.current = null
    requestReadAbort.current = null
    attachmentReadAbort.current = null
    participantReadAbort.current = null
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
    setView(shouldOpenCreateDraft ? 'create' : initialDetail ? 'conversation' : 'create')
    setSubject(initialCreateSubject ?? '')
    setCategory(initialCreateCategory ?? 'GENERAL')
    setRequestBody('')
    setCreateFiles([])
    setReplyBody('')
    setReplyFiles([])
    createOperationId.current = browserUuid()
    replyOperationId.current = browserUuid()
    participantOperation.current = { key: '', id: browserUuid() }
    participantReadGeneration.current += 1
    participantReadInFlight.current = false
    setParticipantCandidates(null)
    setParticipantNextCursor(null)
    setNotice(null)
    setError(null)
    setConflict(false)
    return () => {
      detailReadAbort.current?.abort()
      requestReadAbort.current?.abort()
      attachmentReadAbort.current?.abort()
      participantReadAbort.current?.abort()
      detailReadGeneration.current += 1
      requestReadGeneration.current += 1
      attachmentReadGeneration.current += 1
      participantReadGeneration.current += 1
    }
  }, [
    activeVenue.id,
    initialDetail,
    initialEligibleAttachments,
    initialEligibleAttachmentsNextCursor,
    initialCreateCategory,
    initialCreateSubject,
    initialNextCursor,
    initialRequests,
    shouldOpenCreateDraft,
  ])

  function changeCreateDraft(change: () => void) {
    change()
    createOperationId.current = browserUuid()
  }
  function changeReplyDraft(change: () => void) {
    change()
    replyOperationId.current = browserUuid()
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
    detailReadAbort.current?.abort()
    participantReadAbort.current?.abort()
    detailReadAbort.current = null
    participantReadAbort.current = null
    detailReadGeneration.current += 1
    participantReadGeneration.current += 1
    detailRequestRef.current = null
    messageReadInFlight.current = false
    setDetail(null)
    setRequests((current) => current.filter((request) => request.id !== requestId))
    setReplyBody('')
    setReplyFiles([])
    replyOperationId.current = browserUuid()
    setView('conversation')
    setConflict(false)
    setError('This conversation is not available.')
  }

  async function openRequest(requestId: string) {
    if (writeInFlight.current) return
    const scope = activeVenue.id
    const generation = ++detailReadGeneration.current
    detailReadAbort.current?.abort()
    const controller = new AbortController()
    detailReadAbort.current = controller
    detailRequestRef.current = requestId
    messageReadInFlight.current = false
    clearFeedback()
    const busyOwner = startBusy('detail')
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.support.getRequest.query({ venueId: activeVenue.id, requestId }, { signal }),
      })
      if (
        scopeRef.current !== scope ||
        detailReadGeneration.current !== generation ||
        detailRequestRef.current !== requestId
      )
        return
      if (detail?.id !== requestId || !next.canReply || next.status === 'CANCELLED') {
        setReplyBody('')
        setReplyFiles([])
      }
      setDetail(next as RequestDetail)
      replyOperationId.current = browserUuid()
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
      if (detailReadAbort.current === controller) detailReadAbort.current = null
      finishBusy(busyOwner)
    }
  }

  async function loadMoreEligibleAttachments() {
    if (!eligibleAttachmentsNextCursor || busy || attachmentReadInFlight.current) return
    attachmentReadInFlight.current = true
    const scope = activeVenue.id
    const cursor = eligibleAttachmentsNextCursor
    const generation = ++attachmentReadGeneration.current
    const controller = new AbortController()
    attachmentReadAbort.current = controller
    clearFeedback()
    const busyOwner = startBusy('attachments')
    try {
      const next = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.support.listEligibleAttachments.query(
            { venueId: activeVenue.id, limit: 20, cursor },
            { signal },
          ),
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
      if (attachmentReadAbort.current === controller) attachmentReadAbort.current = null
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
    const controller = new AbortController()
    requestReadAbort.current = controller
    const busyOwner = startBusy('requests')
    setError(null)
    try {
      const page = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.support.listRequests.query({ venueId: activeVenue.id, cursor }, { signal }),
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
      if (requestReadAbort.current === controller) requestReadAbort.current = null
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
    detailReadAbort.current?.abort()
    const controller = new AbortController()
    detailReadAbort.current = controller
    const busyOwner = startBusy('messages')
    setError(null)
    try {
      const next = (await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.support.getRequest.query(
            { venueId: activeVenue.id, requestId, messageCursor: cursor },
            { signal },
          ),
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
      if (detailReadAbort.current === controller) detailReadAbort.current = null
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
    if (writeInFlight.current || attachmentsBlockSending(createFiles)) return
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
        attachments: readyAttachmentIds(createFiles).map((intakeUploadId) => ({ intakeUploadId })),
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
      setCreateFiles([])
      createOperationId.current = browserUuid()
      setView('conversation')
      setNotice('Sent to Torchiko. We’ll reply here.')
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
    if (!detail || !detail.canReply || writeInFlight.current || attachmentsBlockSending(replyFiles))
      return
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
        onboardingResume?: { questionExpired?: boolean }
      } = await (respondingToInformation
        ? client.support.respondToInformation.mutate({
            operationId: replyOperationId.current,
            venueId: activeVenue.id,
            requestId: submittedRequestId,
            expectedClientVersion: detail.clientVersion,
            body: replyBody,
            attachments: readyAttachmentIds(replyFiles).map((intakeUploadId) => ({
              intakeUploadId,
            })),
          })
        : client.support.addMessage.mutate({
            operationId: replyOperationId.current,
            venueId: activeVenue.id,
            requestId: submittedRequestId,
            expectedClientVersion: detail.clientVersion,
            body: replyBody,
            attachments: readyAttachmentIds(replyFiles).map((intakeUploadId) => ({
              intakeUploadId,
            })),
          }))
      if (scopeRef.current !== submittedScope || writeGeneration.current !== generation) return
      setDetail((current) =>
        current?.id === submittedRequestId
          ? {
              ...current,
              clientVersion: result.clientVersion,
              ...(result.status ? { status: result.status } : {}),
              ...(result.missingInformation
                ? { missingInformation: result.missingInformation }
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
                ...(result.status ? { status: result.status } : {}),
                ...(result.missingInformation
                  ? { missingInformation: result.missingInformation }
                  : {}),
              }
            : request,
        ),
      )
      setReplyBody('')
      setReplyFiles([])
      replyOperationId.current = browserUuid()
      setNotice(
        result.onboardingResume?.questionExpired
          ? 'Your reply was saved. The original response window has closed, so the team will review it before work continues.'
          : 'Sent to Torchiko. We’ll reply here.',
      )
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
    const controller = new AbortController()
    participantReadAbort.current = controller
    const busyOwner = startBusy('participants')
    try {
      const result = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: SUPPORT_READ_TIMEOUT_MS,
        request: (signal) =>
          client.support.listParticipantCandidates.query(
            { venueId: scope, requestId, limit: 20, ...(cursor ? { cursor } : {}) },
            { signal },
          ),
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
      if (participantReadAbort.current === controller) participantReadAbort.current = null
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
        participantOperation.current = { key: operationKey, id: browserUuid() }
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

  const conversationOpen = view === 'create' || Boolean(detail) || busy === 'detail'
  const replyBlocked = attachmentsBlockSending(replyFiles)
  const createBlocked = attachmentsBlockSending(createFiles)
  const venueInitials = initials(activeVenue.name)

  function showConversationList() {
    setMobilePane('list')
  }

  return (
    <PortalPage
      title="Help"
      description="Message the Torchiko team. We’re here to help."
      width="wide"
      aside={
        venues.length > 1 ? (
          <label className="block w-full text-sm text-tk-soft sm:w-60">
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
              className={`${portalInput} mt-1`}
            >
              {venues.map((venue) => (
                <option key={venue.id} value={venue.id}>
                  {venue.name}
                </option>
              ))}
            </select>
          </label>
        ) : null
      }
    >
      {returnHref ? (
        <Link
          href={returnHref}
          className={`-mt-2 mb-4 inline-flex min-h-11 items-center gap-2 text-sm ${portalTextLink}`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to setup
        </Link>
      ) : null}

      {operatorSupportHref ? (
        <aside className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          <strong>Operator preview:</strong> this portal lists only conversations and eligible files
          belonging to your admin identity, not everything submitted by the client’s users.{' '}
          <Link className="font-semibold underline underline-offset-4" href={operatorSupportHref}>
            Open this venue’s Support workspace
          </Link>{' '}
          to review all client requests.
        </aside>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start">
        <aside
          aria-label="Conversations"
          className={`${mobilePane === 'list' || !conversationOpen ? '' : 'hidden'} lg:block`}
        >
          <button
            type="button"
            disabled={busy === 'create' || busy === 'reply'}
            onClick={() => {
              if (writeInFlight.current) return
              detailReadGeneration.current += 1
              detailRequestRef.current = null
              setReplyBody('')
              setReplyFiles([])
              replyOperationId.current = browserUuid()
              clearFeedback()
              setView('create')
              setMobilePane('conversation')
            }}
            className={`${portalButtonSecondary} w-full`}
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New conversation
          </button>

          {requests.length === 0 ? (
            <p className="mt-4 px-1 text-sm leading-6 text-tk-soft">No conversations yet.</p>
          ) : (
            <ul className="mt-3 space-y-1">
              {requests.map((request) => {
                const current = view === 'conversation' && detail?.id === request.id
                const waiting = request.status === 'WAITING_FOR_CLIENT' && request.canReply
                return (
                  <li key={request.id}>
                    <button
                      type="button"
                      disabled={busy === 'create' || busy === 'reply'}
                      onClick={() => {
                        setMobilePane('conversation')
                        void openRequest(request.id)
                      }}
                      aria-current={current}
                      className={`flex min-h-14 w-full items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors motion-reduce:transition-none ${portalFocus} ${
                        current ? 'bg-tk-ink-wash' : 'hover:bg-tk-ink/[0.04]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-[0.45rem] h-2 w-2 shrink-0 rounded-full ${
                          waiting ? 'bg-tk-ember' : 'bg-transparent'
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 break-words text-sm font-semibold leading-5">
                          {request.subject}
                        </span>
                        <span className="mt-0.5 block text-[0.8rem] leading-5 text-tk-soft">
                          {supportStatusLabel(request.status)} ·{' '}
                          <span suppressHydrationWarning>
                            {dateLabel(request.clientActivityAt)}
                          </span>
                          {!request.requesterIsCurrentUser ? ' · Your team' : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          {nextCursor ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void loadMoreRequests()}
              className={`mt-2 min-h-11 w-full rounded-lg text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash disabled:opacity-55 ${portalFocus}`}
            >
              {busy === 'requests' ? 'Loading…' : 'Show older conversations'}
            </button>
          ) : null}
        </aside>

        <section
          aria-label="Conversation"
          className={`${mobilePane === 'conversation' || !requests.length ? '' : 'hidden'} min-w-0 rounded-xl border border-tk-rule bg-tk-card lg:block`}
        >
          {conversationOpen && requests.length ? (
            <div className="border-b border-tk-rule px-4 pt-2 lg:hidden">
              <button
                type="button"
                onClick={showConversationList}
                className={`inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-tk-focus ${portalFocus}`}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All conversations
              </button>
            </div>
          ) : null}

          <div className="p-4 sm:p-6">
            {error ? (
              <div
                role="alert"
                className="mb-4 flex items-start gap-3 rounded-lg border border-tk-danger/40 bg-[#FBEFEF] px-3 py-2.5 text-sm leading-6 text-tk-danger"
              >
                <CircleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{error}</span>
                {conflict && detail ? (
                  <button
                    type="button"
                    onClick={() => void openRequest(detail.id)}
                    className={`shrink-0 font-semibold underline underline-offset-2 ${portalFocus}`}
                  >
                    Refresh
                  </button>
                ) : null}
              </div>
            ) : null}
            {notice ? (
              <div className="mb-4">
                <PortalNotice tone="success">{notice}</PortalNotice>
              </div>
            ) : null}

            {busy === 'detail' ? (
              <div
                role="status"
                className="flex min-h-64 items-center justify-center gap-2 text-sm text-tk-soft"
              >
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Opening conversation…
              </div>
            ) : view === 'create' ? (
              <form onSubmit={createRequest} className="max-w-2xl space-y-4">
                <h2 className="font-portal text-[1.45rem] leading-tight">New conversation</h2>
                <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  <label className="block text-sm font-semibold">
                    Subject
                    <input
                      required
                      maxLength={200}
                      value={subject}
                      disabled={busy === 'create'}
                      onChange={(event) => changeCreateDraft(() => setSubject(event.target.value))}
                      className={`${portalInput} mt-1.5 font-normal`}
                    />
                  </label>
                  <label className="block text-sm font-semibold">
                    About
                    <select
                      value={category}
                      disabled={busy === 'create'}
                      onChange={(event) =>
                        changeCreateDraft(() => setCategory(event.target.value as SupportCategory))
                      }
                      className={`${portalInput} mt-1.5 font-normal`}
                    >
                      {categories.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="rounded-lg border border-tk-rule-strong bg-white focus-within:border-tk-focus focus-within:ring-2 focus-within:ring-tk-focus/30">
                  <label className="sr-only" htmlFor="support-new-message">
                    Message
                  </label>
                  <textarea
                    id="support-new-message"
                    required
                    maxLength={20_000}
                    rows={6}
                    value={requestBody}
                    disabled={busy === 'create'}
                    onChange={(event) =>
                      changeCreateDraft(() => setRequestBody(event.target.value))
                    }
                    className="block w-full resize-y rounded-t-lg border-0 bg-transparent px-3.5 py-3 text-sm leading-6 placeholder:text-tk-soft focus:outline-none"
                    placeholder="What would you like us to change, or what’s your question?"
                  />
                  <div className="border-t border-tk-rule px-2 py-1.5">
                    <ComposerAttachments
                      venueId={activeVenue.id}
                      items={createFiles}
                      onChange={(update) => changeCreateDraft(() => setCreateFiles(update))}
                      disabled={busy === 'create'}
                      api={transferApi}
                      eligible={eligibleAttachments}
                      eligibleHasMore={Boolean(eligibleAttachmentsNextCursor)}
                      onLoadMoreEligible={() => void loadMoreEligibleAttachments()}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-3">
                  {createBlocked ? (
                    <p className="text-sm text-tk-soft">Waiting for attachments to finish.</p>
                  ) : null}
                  <button
                    type="submit"
                    disabled={busy !== null || createBlocked}
                    className={portalButtonPrimary}
                  >
                    {busy === 'create' ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {busy === 'create' ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </form>
            ) : detail ? (
              <div className="flex min-h-[26rem] flex-col">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-tk-rule pb-4">
                  <div className="min-w-0">
                    <h2 className="break-words font-portal text-[1.45rem] leading-tight">
                      {detail.subject}
                    </h2>
                    <p className="mt-1 text-sm text-tk-soft">{supportStatusLabel(detail.status)}</p>
                  </div>
                  {detail.requesterIsCurrentUser ? (
                    <details className="group relative">
                      <summary
                        className={`flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-tk-soft hover:bg-tk-ink-wash hover:text-tk-ink [&::-webkit-details-marker]:hidden ${portalFocus}`}
                      >
                        <Users className="h-4 w-4" aria-hidden="true" /> Team access
                      </summary>
                      <div className="mt-2 w-[min(20rem,calc(100vw-4rem))] rounded-lg border border-tk-rule bg-white p-3 shadow-lg sm:absolute sm:right-0 sm:z-10">
                        <p className="text-sm leading-6 text-tk-soft">
                          Choose who on your team can read and reply here.
                        </p>
                        {participantCandidates === null ? (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void loadParticipantCandidates()}
                            className={`${portalButtonSecondary} mt-2 w-full`}
                          >
                            {busy === 'participants' ? 'Loading…' : 'Manage team access'}
                          </button>
                        ) : participantCandidates.length === 0 ? (
                          <p className="mt-2 text-sm text-tk-soft">
                            No other active team members are available.
                          </p>
                        ) : (
                          <ul className="mt-2 divide-y divide-tk-rule">
                            {participantCandidates.map((candidate) => (
                              <li
                                key={candidate.userId}
                                className="flex items-center justify-between gap-3 py-1"
                              >
                                <span className="min-w-0 truncate text-sm font-medium">
                                  {candidate.displayLabel}
                                </span>
                                <button
                                  type="button"
                                  disabled={busy !== null}
                                  onClick={() => void changeParticipant(candidate)}
                                  className={`min-h-11 shrink-0 rounded-md px-2 text-sm font-semibold text-tk-focus hover:bg-tk-ink-wash disabled:opacity-55 ${portalFocus}`}
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
                            className={`mt-1 min-h-11 text-sm font-semibold text-tk-focus disabled:opacity-55 ${portalFocus}`}
                          >
                            Show more team members
                          </button>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                </div>

                {detail.canReply &&
                detail.missingInformation.length > 0 &&
                detail.status !== 'CANCELLED' ? (
                  <section
                    aria-labelledby="support-information-needed"
                    className="mt-4 rounded-lg border border-tk-ember/35 bg-tk-ember-wash px-4 py-3"
                  >
                    <h3
                      id="support-information-needed"
                      className="text-sm font-semibold text-tk-ember-text"
                    >
                      What we need from you
                    </h3>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-6 text-tk-ink">
                      {detail.missingInformation.slice(0, 5).map((item, index) => (
                        <li key={`${index}:${item}`}>{item}</li>
                      ))}
                      {detail.missingInformation.length > 5 ? (
                        <li>{detail.missingInformation.length - 5} more in this conversation</li>
                      ) : null}
                    </ul>
                    <p className="mt-2 text-sm text-tk-soft">
                      Reply below, attach a photo if it helps, or{' '}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          changeReplyDraft(() => setReplyBody("I don't know."))
                          document.getElementById('support-reply')?.focus()
                        }}
                        className={`font-semibold text-tk-focus underline underline-offset-4 disabled:opacity-55 ${portalFocus}`}
                      >
                        say you don’t know
                      </button>
                      .
                    </p>
                  </section>
                ) : null}

                <ol className="flex-1 space-y-3 py-5" aria-live="polite" aria-label="Messages">
                  {detail.messages.filter(isSafeClientMessage).map((message) => {
                    const fromClient = message.authorKind === 'CLIENT'
                    const who = fromClient
                      ? message.authorIsCurrentUser
                        ? 'You'
                        : 'Your team'
                      : 'Torchiko'
                    return (
                      <li
                        key={message.id}
                        className="flex gap-3 rounded-lg border border-tk-rule bg-white px-3.5 py-3"
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[0.8rem] font-bold ${
                            fromClient ? 'bg-tk-ink-wash text-tk-ink' : 'bg-tk-ink text-white'
                          }`}
                        >
                          {fromClient ? venueInitials : 'T'}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span className="font-semibold">{who}</span>
                            <time
                              dateTime={new Date(message.createdAt).toISOString()}
                              className="text-[0.8rem] text-tk-soft"
                              suppressHydrationWarning
                            >
                              {timeLabel(message.createdAt)}
                            </time>
                          </p>
                          {message.completionOutcome ? (
                            <SupportCompletionOutcome
                              outcome={message.completionOutcome}
                              className="mt-1 text-tk-soft"
                            />
                          ) : null}
                          <p className="mt-1 whitespace-pre-wrap break-words text-[0.95rem] leading-6">
                            {message.body}
                          </p>
                          {message.attachments.length > 0 ? (
                            <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
                              {message.attachments.map((attachment) => (
                                <li
                                  key={attachment.id}
                                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-tk-rule bg-tk-paper px-2 py-1 text-[0.8rem] text-tk-ink"
                                >
                                  <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                  <span className="truncate">{attachment.filename}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                  {detail.nextMessageCursor ? (
                    <li>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void loadMoreMessages()}
                        className={`min-h-11 text-sm font-semibold text-tk-focus disabled:opacity-55 ${portalFocus}`}
                      >
                        {busy === 'messages' ? 'Loading…' : 'Load more messages'}
                      </button>
                    </li>
                  ) : null}
                </ol>

                {!detail.canReply || detail.status === 'CANCELLED' ? (
                  <PortalNotice>
                    {detail.status === 'CANCELLED'
                      ? 'This conversation is closed. Start a new one if you need anything else.'
                      : 'You no longer have access to reply to this conversation.'}
                  </PortalNotice>
                ) : (
                  <form onSubmit={sendReply}>
                    {detail.status === 'COMPLETED' ? (
                      <p className="mb-2 text-sm text-tk-soft">
                        Need to add something? Reply here and we’ll pick it back up.
                      </p>
                    ) : null}
                    <div className="rounded-lg border border-tk-rule-strong bg-white focus-within:border-tk-focus focus-within:ring-2 focus-within:ring-tk-focus/30">
                      <label className="sr-only" htmlFor="support-reply">
                        Reply
                      </label>
                      <textarea
                        id="support-reply"
                        required
                        rows={3}
                        maxLength={20_000}
                        value={replyBody}
                        disabled={busy === 'reply'}
                        onChange={(event) => {
                          changeReplyDraft(() => setReplyBody(event.target.value))
                          if (!writeInFlight.current) clearFeedback()
                        }}
                        placeholder="Write a reply…"
                        className="block max-h-[40vh] min-h-[5.5rem] w-full resize-y rounded-t-lg border-0 bg-transparent px-3.5 py-3 text-[0.95rem] leading-6 placeholder:text-tk-soft focus:outline-none"
                      />
                      <div className="flex flex-wrap items-end justify-between gap-2 border-t border-tk-rule px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <ComposerAttachments
                            venueId={activeVenue.id}
                            items={replyFiles}
                            onChange={(update) => changeReplyDraft(() => setReplyFiles(update))}
                            disabled={busy === 'reply'}
                            api={transferApi}
                            eligible={eligibleAttachments}
                            eligibleHasMore={Boolean(eligibleAttachmentsNextCursor)}
                            onLoadMoreEligible={() => void loadMoreEligibleAttachments()}
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={busy !== null || replyBlocked}
                          className={`${portalButtonPrimary} mb-0.5`}
                        >
                          {busy === 'reply' ? (
                            <LoaderCircle
                              className="h-4 w-4 animate-spin motion-reduce:animate-none"
                              aria-hidden="true"
                            />
                          ) : null}
                          {busy === 'reply' ? 'Sending…' : 'Send'}
                        </button>
                      </div>
                    </div>
                    {replyBlocked ? (
                      <p className="mt-2 text-sm text-tk-soft">
                        Send becomes available when your attachments are ready.
                      </p>
                    ) : null}
                  </form>
                )}
              </div>
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center text-center">
                <MessageCircle className="h-7 w-7 text-tk-soft" aria-hidden="true" />
                <h2 className="mt-3 font-portal text-xl">Choose a conversation</h2>
              </div>
            )}
          </div>
        </section>
      </div>
    </PortalPage>
  )
}
