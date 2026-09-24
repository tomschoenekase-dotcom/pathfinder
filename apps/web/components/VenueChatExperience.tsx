'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'
import type { GuestReplyKind } from '@pathfinder/contracts/guest-reply-kind'
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'
import {
  GuestPublicErrorCode,
  type GuestPublicErrorCode as GuestPublicErrorCodeType,
} from '@pathfinder/contracts/guest-response'

import { useGeolocation } from '../hooks/useGeolocation'
import { useNetworkStatus } from '../hooks/useNetworkStatus'
import { useSession } from '../hooks/useSession'
import { useGuestVisitContext } from '../hooks/useGuestVisitContext'
import { useVenueChatAnalytics } from '../hooks/useVenueChatAnalytics'
import { useVisitorId } from '../hooks/useVisitorId'
import { classifyPublicVenueLookupError } from '../lib/public-venue-error'
import { browserUuid } from '../lib/browser-uuid'
import { BoundedClientRequestError, runBoundedClientRequest } from '../lib/bounded-client-request'
import {
  forgetPendingChatTurn,
  readPendingChatTurn,
  rememberPendingChatTurn,
  type RecoverableChatInput,
} from '../lib/pending-chat-turn'
import { useTRPCClient } from '../lib/trpc'
import { getStoredLanguage, SUPPORTED_LANGUAGES } from './LanguagePicker'
import { VenueChatError, VenueChatSkeleton } from './VenueChatStates'
import { VenueChatShell } from './VenueChatShell'
import { VenueTemporarilyUnavailable } from './VenueTemporarilyUnavailable'
import { LocationRoutePlanner } from './LocationRoutePlanner'
import {
  getVisitorRecoveryCopy,
  getVisitorStopCopy,
  localizeVisitorShellError,
} from './visitor-ui-copy'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'
import type { GuestEntrySource } from '../lib/entry-prompt'
import type { FinalizedVoiceTranscriptLine } from './VoiceControl'

type VenueChatExperienceProps = {
  venueSlug: string
  initialVenue?: { slug: string; venue: VenueSummary }
  presentation?: VenueChatPresentation
  initialDraft?: string
  entrySource?: GuestEntrySource
  initialEntryPlaceId?: string
  secondLayerKey?: string
}

type ChatSendInput = inferRouterInputs<AppRouter>['chat']['send']
type ChatSendResult = inferRouterOutputs<AppRouter>['chat']['send']
type ChatStreamEvent =
  | {
      type: 'delta'
      delta: string
      providerFirstTextMs: number
      requestFirstTextMs: number
    }
  | { type: 'complete'; result: ChatSendResult }
type ChatStreamClient = {
  chat: {
    stream?: {
      subscribe: (
        input: ChatSendInput,
        handlers: {
          onData: (event: ChatStreamEvent) => void
          onError: (error: unknown) => void
          onComplete: () => void
        },
      ) => { unsubscribe: () => void }
    }
  }
}
type PendingTurn = {
  operationId: string
  input: RecoverableChatInput
  epoch: number
  venueId: string
  anonymousToken: string
}

type ReplyAwareChatMessage = ChatMessage & { replyKind?: GuestReplyKind }

function normalizeReplyKind(value: unknown): GuestReplyKind {
  return value === 'TEMPORARY_FALLBACK' ? 'TEMPORARY_FALLBACK' : 'ANSWER'
}

function normalizeHistoryMessages(messages: readonly ChatMessage[]): ReplyAwareChatMessage[] {
  return messages.map((message) =>
    message.role === 'assistant'
      ? {
          ...message,
          replyKind: normalizeReplyKind((message as { replyKind?: unknown }).replyKind),
        }
      : message,
  )
}

const VISITOR_READ_TIMEOUT_MS = 15_000
const VISITOR_TURN_TIMEOUT_MS = 60_000
type TurnReconciliation =
  | 'COMPLETE'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'NOT_FOUND'
  | 'PENDING'
  | 'UNAVAILABLE'
  | 'ACCESS_DENIED'

const ACCESS_RECOVERY_MESSAGE =
  'Chat access could not be confirmed. Restore access and reopen this venue link, or open a new tab to start a separate conversation. Nothing has been resent.'

function isUnavailableConversation(error: unknown): boolean {
  return ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(trpcErrorCode(error) ?? '')
}

const EXPANSION_REQUEST_MESSAGES: Record<SupportedChatLanguage, string> = {
  English: 'Tell me more about that.',
  Español: 'Cuéntame más sobre eso.',
  Français: 'Dites-m’en plus à ce sujet.',
  Deutsch: 'Erzähl mir mehr darüber.',
  Italiano: 'Dimmi di più al riguardo.',
  Português: 'Conte-me mais sobre isso.',
  中文: '请再详细介绍一下。',
  日本語: 'それについてもう少し詳しく教えてください。',
  한국어: '그것에 대해 더 자세히 알려 주세요.',
  العربية: 'أخبرني المزيد عن ذلك.',
}

function trpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; data?: { code?: unknown } }
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.data?.code
  return typeof code === 'string' ? code : null
}

function publicGuestErrorCode(error: unknown): GuestPublicErrorCodeType | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as { data?: { publicCode?: unknown } }).data?.publicCode
  const parsed = GuestPublicErrorCode.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function VenueChatExperience({
  venueSlug,
  initialVenue,
  presentation = 'standalone',
  initialDraft = '',
  entrySource,
  initialEntryPlaceId,
  secondLayerKey,
}: VenueChatExperienceProps) {
  const client = useTRPCClient()
  const streamingClient = client as unknown as ChatStreamClient
  const connectionState = useNetworkStatus()
  const isOnline = connectionState !== 'offline'
  const [venueState, setVenueState] = useState<{ slug: string; venue: VenueSummary | null } | null>(
    null,
  )
  const venue = venueState?.slug === venueSlug ? venueState.venue : null
  const [messages, setMessages] = useState<ReplyAwareChatMessage[]>([])
  const [isBooting, setIsBooting] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [characterState, setCharacterState] = useState<CharacterState>('idle')
  const [pageError, setPageError] = useState<string | null>(null)
  const [isVenueUnavailable, setIsVenueUnavailable] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [recoveryMode, setRecoveryMode] = useState<
    'retry-turn' | 'check-history' | 'load-history' | 'access-denied' | null
  >(null)
  const [language, setLanguage] = useState<SupportedChatLanguage>(() => {
    const stored = getStoredLanguage()
    return SUPPORTED_LANGUAGES.some((entry) => entry.label === stored)
      ? (stored as SupportedChatLanguage)
      : 'English'
  })
  const recoveryCopy = getVisitorRecoveryCopy(language)
  const stopCopy = getVisitorStopCopy(language)
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const conversationEpochRef = useRef(0)
  const activeOperationRef = useRef<string | null>(null)
  const activeStreamRef = useRef<{ operationId: string; unsubscribe: () => void } | null>(null)
  const reconciliationAbortRef = useRef<AbortController | null>(null)
  const historyBootstrapAbortRef = useRef<AbortController | null>(null)
  const historyBootstrapFailureRef = useRef<{
    venueId: string
    anonymousToken: string
    epoch: number
  } | null>(null)
  const pendingTurnRef = useRef<PendingTurn | null>(null)
  const currentVenueIdRef = useRef<string | null>(null)
  const currentAnonymousTokenRef = useRef<string | null>(null)
  const reconciliationRequiredRef = useRef(false)
  const stoppedOperationsRef = useRef(new Set<string>())
  const characterResetTimerRef = useRef<number | null>(null)
  const entryPlaceRef = useRef({
    scope: `${venueSlug}:${initialEntryPlaceId ?? ''}`,
    value: initialEntryPlaceId,
  })
  const entryPlaceScope = `${venueSlug}:${initialEntryPlaceId ?? ''}`
  if (entryPlaceRef.current.scope !== entryPlaceScope) {
    entryPlaceRef.current = { scope: entryPlaceScope, value: initialEntryPlaceId }
  }
  const { lat, lng, permission, refresh } = useGeolocation(
    Boolean(venue && venue.guideMode !== 'non_location'),
  )
  const experienceStorageScope = secondLayerKey ? `second-layer:${secondLayerKey}` : 'public'
  const { anonymousToken, sessionId, identityUnavailable, setSessionId, startNewConversation } =
    useSession(venue?.id ?? '', experienceStorageScope)
  const { context: visitContext, clearVisit } = useGuestVisitContext(
    venue?.id ?? '',
    experienceStorageScope,
  )
  const visitorId = useVisitorId()
  const {
    endSession,
    resetAnalytics,
    sessionStartedAtRef,
    trackPlaceEvent,
    trackVisitorAction,
    viewedPlaceIdsRef,
  } = useVenueChatAnalytics({
    venue: secondLayerKey ? null : venue,
    anonymousToken: secondLayerKey ? null : anonymousToken,
    visitorId,
    ...(!secondLayerKey && entrySource ? { entrySource } : {}),
  })

  useLayoutEffect(() => {
    currentVenueIdRef.current = venue?.id ?? null
    currentAnonymousTokenRef.current = anonymousToken
  }, [anonymousToken, venue?.id])

  const clearCharacterReset = useCallback(() => {
    if (characterResetTimerRef.current !== null) {
      window.clearTimeout(characterResetTimerRef.current)
      characterResetTimerRef.current = null
    }
  }, [])

  const setStableCharacterState = useCallback(
    (state: CharacterState) => {
      clearCharacterReset()
      setCharacterState(state)
    },
    [clearCharacterReset],
  )

  const setTemporaryCharacterState = useCallback(
    (state: CharacterState, durationMs: number) => {
      clearCharacterReset()
      setCharacterState(state)
      characterResetTimerRef.current = window.setTimeout(() => {
        characterResetTimerRef.current = null
        setCharacterState('idle')
      }, durationMs)
    },
    [clearCharacterReset],
  )

  useEffect(() => () => clearCharacterReset(), [clearCharacterReset])
  useEffect(
    () => () => {
      // Retire this owner before cancellation can schedule a late completion callback.
      conversationEpochRef.current += 1
      activeOperationRef.current = null
      pendingTurnRef.current = null
      activeStreamRef.current?.unsubscribe()
      activeStreamRef.current = null
      reconciliationAbortRef.current?.abort()
      reconciliationAbortRef.current = null
      historyBootstrapAbortRef.current?.abort()
      historyBootstrapAbortRef.current = null
      stoppedOperationsRef.current.clear()
    },
    [],
  )

  useEffect(() => {
    if (venue && identityUnavailable)
      setSendError('This browser cannot create a private chat session.')
  }, [identityUnavailable, venue])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const epoch = ++conversationEpochRef.current
    async function boot() {
      if (!venueSlug) return
      setIsBooting(true)
      setPageError(null)
      setIsVenueUnavailable(false)
      setMessages([])
      setSendError(null)
      setRecoveryMode(null)
      reconciliationRequiredRef.current = false
      stoppedOperationsRef.current.clear()
      setIsSending(false)
      activeStreamRef.current?.unsubscribe()
      activeStreamRef.current = null
      reconciliationAbortRef.current?.abort()
      reconciliationAbortRef.current = null
      historyBootstrapAbortRef.current?.abort()
      historyBootstrapAbortRef.current = null
      historyBootstrapFailureRef.current = null
      activeOperationRef.current = null
      pendingTurnRef.current = null
      lastSyncedPosRef.current = null
      resetAnalytics()
      try {
        const result =
          initialVenue?.slug === venueSlug && !secondLayerKey
            ? initialVenue.venue
            : await runBoundedClientRequest({
                parentSignal: controller.signal,
                timeoutMs: VISITOR_READ_TIMEOUT_MS,
                request: (signal) =>
                  client.venue.getBySlug.query(
                    {
                      slug: venueSlug,
                      ...(secondLayerKey ? { secondLayerKey } : {}),
                    },
                    { signal },
                  ),
              })
        if (disposed || conversationEpochRef.current !== epoch) return
        setVenueState({ slug: venueSlug, venue: result })
        setTemporaryCharacterState('attention', 900)
        let token: string | null = null
        try {
          token = window.sessionStorage.getItem(
            experienceStorageScope === 'public'
              ? `pathfinder_session_${result.id}`
              : `pathfinder_session_${result.id}_${experienceStorageScope}`,
          )
        } catch {
          // The session hook retains its in-memory privacy boundary.
        }
        if (token) {
          const saved = readPendingChatTurn({
            venueId: result.id,
            anonymousToken: token,
            ...(secondLayerKey ? { secondLayerKey } : {}),
          })
          if (saved.kind === 'invalid') {
            reconciliationRequiredRef.current = true
            setRecoveryMode('access-denied')
            setSendError(
              'This tab could not safely restore its pending message. Keep any draft you need, then reopen the venue in a new tab. Nothing has been resent.',
            )
            return
          }
          const restoredTurn: PendingTurn | null =
            saved.kind === 'found'
              ? {
                  operationId: saved.input.operationId,
                  input: saved.input,
                  epoch,
                  venueId: result.id,
                  anonymousToken: token,
                }
              : null
          if (restoredTurn) {
            pendingTurnRef.current = restoredTurn
            reconciliationRequiredRef.current = true
            entryPlaceRef.current.value = undefined
            setMessages([
              {
                role: 'user',
                content: restoredTurn.input.message,
                pendingOperationId: restoredTurn.operationId,
              },
            ])
          }
          try {
            const history = await runBoundedClientRequest({
              parentSignal: controller.signal,
              timeoutMs: VISITOR_READ_TIMEOUT_MS,
              request: (signal) =>
                client.chat.history.query(
                  {
                    venueId: result.id,
                    anonymousToken: token,
                    ...(restoredTurn ? { operationId: restoredTurn.operationId } : {}),
                    ...(secondLayerKey ? { secondLayerKey } : {}),
                  },
                  { signal },
                ),
            })
            if (!disposed && conversationEpochRef.current === epoch) {
              historyBootstrapFailureRef.current = null
              if (restoredTurn) {
                const scopedTurn = 'turn' in history ? history.turn : null
                if (scopedTurn && scopedTurn.operationId !== restoredTurn.operationId) {
                  setRecoveryMode('check-history')
                  setSendError(getVisitorRecoveryCopy()[2])
                } else if (scopedTurn?.status === 'COMPLETE') {
                  setMessages(normalizeHistoryMessages(history.messages as ChatMessage[]))
                  forgetPendingChatTurn(restoredTurn.input)
                  pendingTurnRef.current = null
                  reconciliationRequiredRef.current = false
                } else if (scopedTurn?.status === 'FAILED' || scopedTurn?.status === 'AMBIGUOUS') {
                  setMessages([
                    ...normalizeHistoryMessages(history.messages as ChatMessage[]),
                    {
                      role: 'user',
                      content: restoredTurn.input.message,
                      pendingOperationId: restoredTurn.operationId,
                    },
                  ])
                  forgetPendingChatTurn(restoredTurn.input)
                  pendingTurnRef.current = null
                  reconciliationRequiredRef.current = false
                  setSendError(getVisitorRecoveryCopy()[0])
                } else {
                  setMessages([
                    ...normalizeHistoryMessages(history.messages as ChatMessage[]),
                    {
                      role: 'user',
                      content: restoredTurn.input.message,
                      pendingOperationId: restoredTurn.operationId,
                    },
                  ])
                  setRecoveryMode(scopedTurn ? 'check-history' : 'retry-turn')
                  setSendError(getVisitorRecoveryCopy()[scopedTurn ? 2 : 7])
                }
              } else if (history.messages.length)
                setMessages(normalizeHistoryMessages(history.messages as ChatMessage[]))
            }
          } catch (error) {
            if (!disposed && conversationEpochRef.current === epoch) {
              historyBootstrapFailureRef.current = restoredTurn
                ? null
                : {
                    venueId: result.id,
                    anonymousToken: token,
                    epoch,
                  }
              const denied = isUnavailableConversation(error)
              if (denied) reconciliationRequiredRef.current = true
              setRecoveryMode(
                denied ? 'access-denied' : restoredTurn ? 'check-history' : 'load-history',
              )
              setSendError(denied ? ACCESS_RECOVERY_MESSAGE : getVisitorRecoveryCopy()[2])
              setStableCharacterState('error')
            }
          }
        }
      } catch (error) {
        if (!disposed && conversationEpochRef.current === epoch) {
          const failure = classifyPublicVenueLookupError(error)
          setIsVenueUnavailable(failure === 'temporarily-unavailable')
          setPageError(
            failure === 'not-found'
              ? 'We could not find this venue.'
              : 'We could not load this venue. Please try again.',
          )
          setVenueState({ slug: venueSlug, venue: null })
        }
      } finally {
        if (!disposed && conversationEpochRef.current === epoch) setIsBooting(false)
      }
    }
    void boot()
    return () => {
      disposed = true
      controller.abort()
    }
  }, [
    client,
    experienceStorageScope,
    initialVenue,
    resetAnalytics,
    secondLayerKey,
    setTemporaryCharacterState,
    setStableCharacterState,
    venueSlug,
  ])

  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    async function ensureSession() {
      if (!isOnline || !venue || !anonymousToken) return
      if (lat === null || lng === null) lastSyncedPosRef.current = null
      if (lat !== null && lng !== null && lastSyncedPosRef.current) {
        if (
          Math.abs(lat - lastSyncedPosRef.current.lat) < 0.0001 &&
          Math.abs(lng - lastSyncedPosRef.current.lng) < 0.0001
        )
          return
      }
      const epoch = conversationEpochRef.current
      try {
        const admission = client.chat.session.mutate({
          venueId: venue.id,
          anonymousToken,
          ...(secondLayerKey ? { secondLayerKey } : {}),
          ...(visitorId ? { visitorId } : {}),
          ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null
            ? { lat, lng }
            : {}),
        })
        const result = await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: VISITOR_READ_TIMEOUT_MS,
          request: () => admission,
        })
        if (!disposed && conversationEpochRef.current === epoch) {
          setSessionId(result.sessionId)
          if (lat !== null && lng !== null) lastSyncedPosRef.current = { lat, lng }
        }
      } catch (error) {
        if (!disposed && conversationEpochRef.current === epoch) {
          if (classifyPublicVenueLookupError(error) === 'temporarily-unavailable')
            setIsVenueUnavailable(true)
          else setSendError('We could not prepare the chat session. Please try again.')
        }
      }
    }
    void ensureSession()
    return () => {
      disposed = true
      controller.abort()
    }
  }, [anonymousToken, client, isOnline, lat, lng, secondLayerKey, setSessionId, venue, visitorId])

  function turnScopeIsCurrent(turn: PendingTurn) {
    return (
      conversationEpochRef.current === turn.epoch &&
      currentVenueIdRef.current === turn.venueId &&
      currentAnonymousTokenRef.current === turn.anonymousToken
    )
  }

  function turnIsCurrent(turn: PendingTurn) {
    return turnScopeIsCurrent(turn) && pendingTurnRef.current?.operationId === turn.operationId
  }

  function applyStreamDelta(turn: PendingTurn, delta: string) {
    if (!delta || stoppedOperationsRef.current.has(turn.operationId) || !turnIsCurrent(turn)) return
    setStableCharacterState('speaking')
    setMessages((current) => {
      const existingIndex = current.findIndex(
        (message) =>
          message.role === 'assistant' && message.pendingOperationId === turn.operationId,
      )
      if (existingIndex === -1) {
        return [
          ...current,
          {
            role: 'assistant',
            content: delta,
            pendingOperationId: turn.operationId,
          },
        ]
      }
      return current.map((message, index) =>
        index === existingIndex ? { ...message, content: message.content + delta } : message,
      )
    })
  }

  async function sendTurnRequest(turn: PendingTurn): Promise<ChatSendResult> {
    const stream = streamingClient.chat.stream
    const controller = new AbortController()
    let retired = false
    let subscription: { unsubscribe: () => void } | undefined
    let rejectRequest: (error: unknown) => void = () => undefined
    const unsubscribe = () => {
      const current = subscription
      subscription = undefined
      current?.unsubscribe()
    }
    const owner = {
      operationId: turn.operationId,
      unsubscribe: () => {
        retired = true
        controller.abort()
        unsubscribe()
        rejectRequest(new BoundedClientRequestError('CANCELLED'))
      },
    }
    activeStreamRef.current = owner
    const request = new Promise<ChatSendResult>((resolve, reject) => {
      rejectRequest = reject
      const finish = (result: ChatSendResult) => {
        if (retired) return
        retired = true
        resolve(result)
      }
      const fail = (error: unknown) => {
        if (retired) return
        retired = true
        reject(error)
      }
      if (!stream?.subscribe) {
        // Legacy non-stream callers retain the same immutable request and local Stop
        // semantics. Cancelling the view is not a claim that provider work was cancelled.
        void client.chat.send.mutate(turn.input).then(finish, fail)
        return
      }
      subscription = stream.subscribe(turn.input, {
        onData(event) {
          if (retired || !turnIsCurrent(turn)) return
          if (event.type === 'delta') applyStreamDelta(turn, event.delta)
          else if (event.type === 'complete') finish(event.result)
        },
        onError: fail,
        onComplete() {
          fail(new Error('The guide stream ended before completion.'))
        },
      })
      if (retired) unsubscribe() // A deterministic/local transport may complete synchronously.
    })
    try {
      return await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: VISITOR_TURN_TIMEOUT_MS,
        request: () => request,
      })
    } finally {
      owner.unsubscribe()
      if (activeStreamRef.current === owner) activeStreamRef.current = null
    }
  }

  function applyTurnHistory(
    turn: PendingTurn,
    history: inferRouterOutputs<AppRouter>['chat']['history'],
  ): TurnReconciliation {
    const scopedTurn = 'turn' in history ? history.turn : null
    if (scopedTurn && scopedTurn.operationId !== turn.operationId) return 'UNAVAILABLE'
    if (!Array.isArray(history.messages)) return 'UNAVAILABLE'
    if (!scopedTurn) return 'NOT_FOUND'
    if (!['COMPLETE', 'FAILED', 'AMBIGUOUS'].includes(scopedTurn.status)) return 'PENDING'
    const restored = normalizeHistoryMessages(history.messages as ChatMessage[])
    // The database owner commits both text messages only on COMPLETE. Terminal
    // failures have no committed pair: keep the guest's exact local text, not a
    // partial assistant fragment that could be mistaken for an authoritative answer.
    setMessages(
      scopedTurn.status === 'COMPLETE'
        ? restored
        : [
            ...restored,
            {
              role: 'user',
              content: turn.input.message,
              pendingOperationId: turn.operationId,
            },
          ],
    )
    return scopedTurn.status as 'COMPLETE' | 'FAILED' | 'AMBIGUOUS'
  }

  function finishReconciliation(
    turn: PendingTurn,
    outcome: TurnReconciliation,
    stopped = false,
    offerExactReplay = false,
  ) {
    if (outcome === 'ACCESS_DENIED') {
      reconciliationRequiredRef.current = true
      setRecoveryMode('access-denied')
      setSendError(ACCESS_RECOVERY_MESSAGE)
      return
    }
    if (outcome === 'COMPLETE' || outcome === 'FAILED' || outcome === 'AMBIGUOUS') {
      forgetPendingChatTurn(turn.input)
      pendingTurnRef.current = null
      reconciliationRequiredRef.current = false
      stoppedOperationsRef.current.delete(turn.operationId)
      setRecoveryMode(null)
      setSendError(
        outcome === 'COMPLETE'
          ? stopped
            ? stopCopy.refreshed
            : recoveryCopy[8]
          : 'The original message outcome could not be confirmed and will not be retried. The conversation was refreshed; you may send a new message.',
      )
    } else {
      reconciliationRequiredRef.current = true
      const canProbeExactOwner =
        outcome === 'NOT_FOUND' || (outcome === 'PENDING' && offerExactReplay)
      setRecoveryMode(canProbeExactOwner ? 'retry-turn' : 'check-history')
      setSendError(canProbeExactOwner ? getVisitorRecoveryCopy()[7] : getVisitorRecoveryCopy()[2])
    }
  }

  async function reconcileTurn(turn: PendingTurn): Promise<TurnReconciliation> {
    reconciliationAbortRef.current?.abort()
    const controller = new AbortController()
    reconciliationAbortRef.current = controller
    try {
      const history = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: VISITOR_READ_TIMEOUT_MS,
        request: (signal) =>
          client.chat.history.query(
            {
              venueId: turn.venueId,
              anonymousToken: turn.anonymousToken,
              operationId: turn.operationId,
              ...(turn.input.secondLayerKey ? { secondLayerKey: turn.input.secondLayerKey } : {}),
            },
            { signal },
          ),
      })
      if (!turnIsCurrent(turn)) return 'UNAVAILABLE'
      return applyTurnHistory(turn, history)
    } catch (error) {
      // Retain the frozen operation. A failed reconciliation must not invent an empty history.
      return isUnavailableConversation(error) ? 'ACCESS_DENIED' : 'UNAVAILABLE'
    } finally {
      if (reconciliationAbortRef.current === controller) reconciliationAbortRef.current = null
    }
  }

  async function retryHistoryBootstrap() {
    const failure = historyBootstrapFailureRef.current
    if (!failure || activeOperationRef.current !== null || historyBootstrapAbortRef.current) return
    const controller = new AbortController()
    historyBootstrapAbortRef.current = controller
    setIsSending(true)
    try {
      const history = await runBoundedClientRequest({
        parentSignal: controller.signal,
        timeoutMs: VISITOR_READ_TIMEOUT_MS,
        request: (signal) =>
          client.chat.history.query(
            {
              venueId: failure.venueId,
              anonymousToken: failure.anonymousToken,
              ...(secondLayerKey ? { secondLayerKey } : {}),
            },
            { signal },
          ),
      })
      if (
        historyBootstrapFailureRef.current !== failure ||
        conversationEpochRef.current !== failure.epoch ||
        currentVenueIdRef.current !== failure.venueId ||
        currentAnonymousTokenRef.current !== failure.anonymousToken
      )
        return
      setMessages(normalizeHistoryMessages(history.messages as ChatMessage[]))
      historyBootstrapFailureRef.current = null
      setRecoveryMode(null)
      setSendError(null)
      setTemporaryCharacterState('success', 900)
    } catch (error) {
      if (
        historyBootstrapFailureRef.current === failure &&
        conversationEpochRef.current === failure.epoch
      ) {
        if (isUnavailableConversation(error)) {
          reconciliationRequiredRef.current = true
          setRecoveryMode('access-denied')
          setSendError(ACCESS_RECOVERY_MESSAGE)
        } else setSendError(getVisitorRecoveryCopy()[9])
      }
    } finally {
      if (historyBootstrapAbortRef.current === controller) {
        historyBootstrapAbortRef.current = null
        if (conversationEpochRef.current === failure.epoch) setIsSending(false)
      }
    }
  }

  async function dispatchTurn(turn: PendingTurn, addOptimistic: boolean) {
    if (activeOperationRef.current !== null || !turnIsCurrent(turn)) return
    activeOperationRef.current = turn.operationId
    // The in-flight owner fences new sends; do not leave the recovery lock on the
    // composer button, because that would also disable its real Stop control.
    reconciliationRequiredRef.current = false
    setSendError(null)
    setRecoveryMode(null)
    setIsSending(true)
    setStableCharacterState('thinking')
    if (addOptimistic)
      setMessages((current) => [
        ...current,
        {
          role: 'user',
          content: turn.input.message,
          pendingOperationId: turn.operationId,
        },
      ])
    try {
      const result = await sendTurnRequest(turn)
      if (stoppedOperationsRef.current.has(turn.operationId)) return
      if (!turnIsCurrent(turn)) return
      const response = result.response
      const replyKind = normalizeReplyKind(result.replyKind)
      const resultPlaces = result.places
      const resultCitations = Array.isArray(result.citations) ? result.citations : []
      if (typeof response !== 'string' || !Array.isArray(resultPlaces)) {
        throw new Error('The completed chat turn response was incomplete.')
      }
      setMessages((current) => [
        ...current
          .filter(
            (message) =>
              !(message.role === 'assistant' && message.pendingOperationId === turn.operationId),
          )
          .map((message) =>
            message.pendingOperationId === turn.operationId
              ? { role: message.role, content: message.content }
              : message,
          ),
        {
          ...(result.assistantMessageId ? { id: result.assistantMessageId } : {}),
          role: 'assistant',
          content: response,
          replyKind,
          places: resultPlaces as NonNullable<ChatMessage['places']>,
          ...(resultCitations.length
            ? {
                blocks: [
                  {
                    type: 'citations' as const,
                    citations: resultCitations,
                  },
                ],
              }
            : {}),
        },
      ])
      setSessionId(result.sessionId)
      forgetPendingChatTurn(turn.input)
      pendingTurnRef.current = null
      reconciliationRequiredRef.current = false
      setRecoveryMode(null)
      setTemporaryCharacterState(
        replyKind === 'TEMPORARY_FALLBACK' ? 'error' : 'success',
        replyKind === 'TEMPORARY_FALLBACK' ? 1600 : 900,
      )
    } catch (error) {
      if (stoppedOperationsRef.current.has(turn.operationId)) return
      if (!turnIsCurrent(turn)) return
      const code = trpcErrorCode(error)
      const publicCode = publicGuestErrorCode(error)
      setMessages((current) =>
        current.filter(
          (message) =>
            !(message.role === 'assistant' && message.pendingOperationId === turn.operationId),
        ),
      )
      if (
        publicCode === 'OUTCOME_AMBIGUOUS' ||
        code === 'CONFLICT' ||
        code === 'PRECONDITION_FAILED'
      ) {
        const reconciled = await reconcileTurn(turn)
        if (!turnIsCurrent(turn)) return
        finishReconciliation(turn, reconciled)
      } else if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
        reconciliationRequiredRef.current = true
        setRecoveryMode('access-denied')
        setSendError(ACCESS_RECOVERY_MESSAGE)
      } else if (
        publicCode === 'PROVIDER_UNAVAILABLE' ||
        publicCode === 'CONTENT_UNAVAILABLE' ||
        publicCode === 'REJECTED' ||
        publicCode === 'TRANSIENT_FAILURE' ||
        code === 'BAD_REQUEST' ||
        code === 'NOT_FOUND'
      ) {
        forgetPendingChatTurn(turn.input)
        pendingTurnRef.current = null
        reconciliationRequiredRef.current = false
        setRecoveryMode(null)
        setSendError(
          publicCode === 'PROVIDER_UNAVAILABLE'
            ? 'The guide service is temporarily unavailable. Wait a moment, then send a new message.'
            : publicCode === 'CONTENT_UNAVAILABLE'
              ? 'This venue content is not available right now. Try again later or ask venue staff.'
              : publicCode === 'TRANSIENT_FAILURE'
                ? 'The guide could not start this message. Wait a moment, then send it again as a new message.'
                : 'This message could not be accepted. Review it before sending a new message.',
        )
      } else {
        reconciliationRequiredRef.current = true
        setRecoveryMode('retry-turn')
        // RATE_LIMITED also represents the existing server IN_PROGRESS fence; it is
        // not proof that an earlier request was never sent. Reconcile before replay.
        setSendError('The outcome of this message is not confirmed. Retry the same message safely.')
      }
      setTemporaryCharacterState('error', 1600)
    } finally {
      if (activeStreamRef.current?.operationId === turn.operationId) {
        activeStreamRef.current.unsubscribe()
        activeStreamRef.current = null
      }
      if (
        activeOperationRef.current === turn.operationId &&
        !stoppedOperationsRef.current.has(turn.operationId)
      ) {
        setIsSending(false)
        activeOperationRef.current = null
      }
    }
  }

  function handleSend(raw: string, responseIntent: 'DEFAULT' | 'EXPAND' = 'DEFAULT'): boolean {
    const message = raw.trim()
    if (
      !isOnline ||
      isBooting ||
      !venue ||
      !anonymousToken ||
      !message ||
      activeOperationRef.current !== null ||
      reconciliationRequiredRef.current ||
      pendingTurnRef.current !== null ||
      recoveryMode === 'load-history'
    )
      return false
    const epoch = conversationEpochRef.current
    const operationId = browserUuid()
    if (!operationId) {
      setSendError(
        'This browser cannot create a private message identity. Please try another browser.',
      )
      return false
    }
    const input: RecoverableChatInput = {
      operationId,
      venueId: venue.id,
      anonymousToken,
      ...(secondLayerKey ? { secondLayerKey } : {}),
      ...(visitorId ? { visitorId } : {}),
      ...(entryPlaceRef.current.value ? { entryPlaceId: entryPlaceRef.current.value } : {}),
      message,
      ...(visitContext.interests.length ||
      visitContext.visitedPlaceIds.length ||
      visitContext.remainingMinutes != null
        ? { visitContext }
        : {}),
      ...(responseIntent === 'EXPAND' ? { responseIntent } : {}),
      ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null ? { lat, lng } : {}),
      ...(language === 'English' ? {} : { language }),
    }
    entryPlaceRef.current.value = undefined
    const turn = { operationId, input, epoch, venueId: venue.id, anonymousToken }
    pendingTurnRef.current = turn
    rememberPendingChatTurn(input)
    void dispatchTurn(turn, true)
    return true
  }

  function handleRetry() {
    if (!isOnline || recoveryMode === 'access-denied') return
    if (recoveryMode === 'load-history') {
      void retryHistoryBootstrap()
      return
    }
    const turn = pendingTurnRef.current
    if (!turn) return
    if (recoveryMode === 'check-history' || recoveryMode === 'retry-turn') {
      const retryRequested = recoveryMode === 'retry-turn'
      void (async () => {
        if (activeOperationRef.current !== null) return
        activeOperationRef.current = turn.operationId
        setIsSending(true)
        setRecoveryMode('check-history')
        const reconciled = await reconcileTurn(turn)
        if (turnIsCurrent(turn)) {
          setIsSending(false)
          if ((reconciled === 'NOT_FOUND' || reconciled === 'PENDING') && retryRequested) {
            // Only the visitor's explicit retry may cross the send boundary; replay
            // the frozen operation, never today's language, location, QR or draft.
            // Only the existing reservation owner can decide whether a pending lease
            // is busy, resumable or terminal. History-only polling cannot retire an
            // expired RESERVED/GENERATING lease. It must never create a new operation.
            activeOperationRef.current = null
            stoppedOperationsRef.current.delete(turn.operationId)
            void dispatchTurn(turn, false)
            return
          }
          finishReconciliation(turn, reconciled, false, true)
        }
        if (activeOperationRef.current === turn.operationId) activeOperationRef.current = null
      })()
    }
  }

  function handleStopResponse() {
    const turn = pendingTurnRef.current
    if (!turn || activeOperationRef.current !== turn.operationId) return
    stoppedOperationsRef.current.add(turn.operationId)
    if (stoppedOperationsRef.current.size > 8) {
      const oldest = stoppedOperationsRef.current.values().next().value
      if (oldest) stoppedOperationsRef.current.delete(oldest)
    }
    reconciliationRequiredRef.current = true
    if (activeStreamRef.current?.operationId === turn.operationId) {
      activeStreamRef.current.unsubscribe()
      activeStreamRef.current = null
    }
    setSendError(stopCopy.checking)
    setStableCharacterState('idle')
    setRecoveryMode('check-history')
    setIsSending(true)
    setMessages((current) =>
      current.filter(
        (message) =>
          !(message.role === 'assistant' && message.pendingOperationId === turn.operationId),
      ),
    )
    void reconcileTurn(turn).then((reconciled) => {
      if (!turnIsCurrent(turn)) return
      activeOperationRef.current = null
      finishReconciliation(turn, reconciled, true)
      setIsSending(false)
    })
  }

  function handleDraftChange(draft = '') {
    if (activeOperationRef.current !== null || pendingTurnRef.current) return
    setStableCharacterState(draft.trim() ? 'listening' : 'idle')
  }

  function handleNewConversation() {
    if (
      !isOnline ||
      isBooting ||
      !venue ||
      !anonymousToken ||
      isSending ||
      activeOperationRef.current !== null ||
      reconciliationRequiredRef.current
    )
      return
    if (messages.length && !window.confirm(recoveryCopy[10])) return
    const previousToken = anonymousToken
    const previousStartedAt = sessionStartedAtRef.current
    if (!startNewConversation()) {
      setSendError('We could not start a new conversation in this browser.')
      return
    }
    clearVisit()
    conversationEpochRef.current += 1
    activeOperationRef.current = null
    pendingTurnRef.current = null
    historyBootstrapAbortRef.current?.abort()
    historyBootstrapAbortRef.current = null
    historyBootstrapFailureRef.current = null
    setMessages([])
    setSendError(null)
    setRecoveryMode(null)
    reconciliationRequiredRef.current = false
    stoppedOperationsRef.current.clear()
    lastSyncedPosRef.current = null
    resetAnalytics()
    setTemporaryCharacterState('attention', 900)
    endSession(venue.id, previousToken, previousStartedAt)
  }

  if (venueState?.slug !== venueSlug) return <VenueChatSkeleton language={language} />
  if (isVenueUnavailable)
    return (
      <VenueTemporarilyUnavailable
        showHomeLink={presentation === 'standalone'}
        language={language}
      />
    )
  if (!venue)
    return (
      <VenueChatError
        message={
          localizeVisitorShellError(pageError ?? 'This venue link is not active.', language) ??
          'This venue link is not active.'
        }
        presentation={presentation}
        language={language}
      />
    )

  const handleVoiceTranscriptLine = (line: FinalizedVoiceTranscriptLine) => {
    if (
      currentVenueIdRef.current !== line.venueId ||
      currentAnonymousTokenRef.current !== line.anonymousToken
    )
      return
    setMessages((current) => {
      const message: ChatMessage = {
        id: line.id,
        role: line.role,
        content: line.content,
        voiceDelivery: line.voiceDelivery,
        voicePersistence: line.persistence,
      }
      const existingIndex = current.findIndex((entry) => entry.id === line.id)
      if (existingIndex === -1) return [...current, message]
      return current.map((entry, index) => (index === existingIndex ? message : entry))
    })
  }

  return (
    <VenueChatShell
      venue={venue}
      venueSlug={venueSlug}
      presentation={presentation}
      messages={messages}
      isSending={isSending}
      isRestoringHistory={isBooting}
      sendError={sendError}
      anonymousToken={anonymousToken}
      language={language}
      setLanguage={setLanguage}
      initialDraft={initialDraft}
      connectionState={connectionState}
      characterState={characterState}
      location={{ lat, lng, permission, refresh }}
      routePlanner={
        !secondLayerKey ? (
          <LocationRoutePlanner
            key={`${venue.id}:${anonymousToken ?? 'pending'}:${sessionId ?? 'unconfirmed'}`}
            venueId={venue.id}
            anonymousToken={sessionId ? anonymousToken : null}
            disabled={!isOnline || isSending || reconciliationRequiredRef.current}
            language={language}
          />
        ) : null
      }
      onSend={(message) => handleSend(message)}
      {...(messages.at(-1)?.replyKind !== 'TEMPORARY_FALLBACK'
        ? { onRequestMore: () => handleSend(EXPANSION_REQUEST_MESSAGES[language], 'EXPAND') }
        : {})}
      requestMoreLabel={EXPANSION_REQUEST_MESSAGES[language].replace(/[.。]$/u, '')}
      onDraftChange={handleDraftChange}
      onRetry={recoveryMode && recoveryMode !== 'access-denied' ? handleRetry : null}
      retryLabel={
        recoveryMode === 'check-history' || recoveryMode === 'load-history'
          ? recoveryCopy[12]
          : recoveryCopy[13]
      }
      {...(isSending && recoveryMode !== 'check-history' && recoveryMode !== 'load-history'
        ? { onStopResponse: handleStopResponse }
        : {})}
      stopResponseLabel={stopCopy.stop}
      conversationLocked={
        reconciliationRequiredRef.current ||
        recoveryMode === 'check-history' ||
        recoveryMode === 'load-history'
      }
      onNewConversation={() => handleNewConversation()}
      visitContext={visitContext}
      onVoiceCharacterState={setStableCharacterState}
      onVoiceTranscriptLine={handleVoiceTranscriptLine}
      {...(recoveryMode || reconciliationRequiredRef.current ? { voiceControl: null } : {})}
      onPlaceView={(placeId) => {
        if (!viewedPlaceIdsRef.current.has(placeId)) {
          viewedPlaceIdsRef.current.add(placeId)
          trackPlaceEvent('place_card.viewed', placeId)
        }
      }}
      onPlaceClick={(placeId) => trackPlaceEvent('place_card.clicked', placeId)}
      onDirections={(placeId) => trackPlaceEvent('directions.opened', placeId)}
      onVisitorAction={trackVisitorAction}
      {...(!secondLayerKey && anonymousToken
        ? {
            onMessageFeedback: async (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => {
              await client.feedback.submit.mutate({
                venueId: venue.id,
                anonymousToken,
                messageId,
                rating,
              })
            },
          }
        : {})}
    />
  )
}
