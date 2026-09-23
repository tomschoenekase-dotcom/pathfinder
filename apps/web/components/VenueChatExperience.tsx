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
import { GuestVisitPreferences } from './GuestVisitPreferences'
import { useVenueChatAnalytics } from '../hooks/useVenueChatAnalytics'
import { useVisitorId } from '../hooks/useVisitorId'
import { classifyPublicVenueLookupError } from '../lib/public-venue-error'
import { browserUuid } from '../lib/browser-uuid'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
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
  input: ChatSendInput
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
    'retry-turn' | 'check-history' | 'load-history' | null
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
  const {
    context: visitContext,
    updateContext: updateVisitContext,
    clearVisit,
  } = useGuestVisitContext(venue?.id ?? '', experienceStorageScope)
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
        const result = await runBoundedClientRequest({
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
          try {
            const history = await runBoundedClientRequest({
              parentSignal: controller.signal,
              timeoutMs: VISITOR_READ_TIMEOUT_MS,
              request: (signal) =>
                client.chat.history.query(
                  {
                    venueId: result.id,
                    anonymousToken: token,
                    ...(secondLayerKey ? { secondLayerKey } : {}),
                  },
                  { signal },
                ),
            })
            if (!disposed && conversationEpochRef.current === epoch) {
              historyBootstrapFailureRef.current = null
              if (history.messages.length)
                setMessages(normalizeHistoryMessages(history.messages as ChatMessage[]))
            }
          } catch {
            if (!disposed && conversationEpochRef.current === epoch) {
              historyBootstrapFailureRef.current = {
                venueId: result.id,
                anonymousToken: token,
                epoch,
              }
              setRecoveryMode('load-history')
              setSendError(getVisitorRecoveryCopy()[2])
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
    resetAnalytics,
    secondLayerKey,
    setTemporaryCharacterState,
    setStableCharacterState,
    venueSlug,
  ])

  useEffect(() => {
    let disposed = false
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
        const result = await client.chat.session.mutate({
          venueId: venue.id,
          anonymousToken,
          ...(secondLayerKey ? { secondLayerKey } : {}),
          ...(visitorId ? { visitorId } : {}),
          ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null
            ? { lat, lng }
            : {}),
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

  function abandonPendingOptimistic() {
    const abandonedOperationId = pendingTurnRef.current?.operationId
    if (!abandonedOperationId) return
    setMessages((current) =>
      current.filter((message) => message.pendingOperationId !== abandonedOperationId),
    )
    pendingTurnRef.current = null
    setRecoveryMode(null)
    setSendError(null)
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
    if (!stream?.subscribe) return client.chat.send.mutate(turn.input)
    return new Promise<ChatSendResult>((resolve, reject) => {
      let completed = false
      const subscription = stream.subscribe(turn.input, {
        onData(event) {
          if (event.type === 'delta') {
            applyStreamDelta(turn, event.delta)
            return
          }
          completed = true
          resolve(event.result)
        },
        onError(error) {
          reject(error)
        },
        onComplete() {
          if (!completed) reject(new Error('The guide stream ended before completion.'))
        },
      })
      activeStreamRef.current = {
        operationId: turn.operationId,
        unsubscribe: () => subscription.unsubscribe(),
      }
    })
  }

  async function reconcileTurn(turn: PendingTurn): Promise<boolean> {
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
              ...(secondLayerKey ? { secondLayerKey } : {}),
            },
            { signal },
          ),
      })
      if (!turnIsCurrent(turn)) return false
      const scopedTurn = 'turn' in history ? history.turn : null
      if (
        !scopedTurn ||
        scopedTurn.operationId !== turn.operationId ||
        !['COMPLETE', 'FAILED', 'AMBIGUOUS'].includes(scopedTurn.status)
      )
        return false
      setMessages(normalizeHistoryMessages(history.messages as ChatMessage[]))
      reconciliationRequiredRef.current = false
      return true
    } catch {
      // Retain the frozen operation. A failed reconciliation must not invent an empty history.
      return false
    } finally {
      if (reconciliationAbortRef.current === controller) reconciliationAbortRef.current = null
    }
  }

  async function retryHistoryBootstrap() {
    const failure = historyBootstrapFailureRef.current
    if (!failure || activeOperationRef.current !== null) return
    historyBootstrapAbortRef.current?.abort()
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
    } catch {
      if (
        historyBootstrapFailureRef.current === failure &&
        conversationEpochRef.current === failure.epoch
      )
        setSendError(getVisitorRecoveryCopy()[9])
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
      pendingTurnRef.current = null
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
      if (
        publicCode === 'OUTCOME_AMBIGUOUS' ||
        code === 'CONFLICT' ||
        code === 'PRECONDITION_FAILED'
      ) {
        const reconciled = await reconcileTurn(turn)
        if (!turnIsCurrent(turn)) return
        if (reconciled) {
          pendingTurnRef.current = null
          setRecoveryMode(null)
          setSendError(
            publicCode === 'OUTCOME_AMBIGUOUS' || code === 'PRECONDITION_FAILED'
              ? 'The original message outcome could not be confirmed and will not be retried. The conversation was refreshed; you may send a new message.'
              : 'The conversation changed while this message was being checked. Review the refreshed conversation before sending a new message.',
          )
        } else {
          reconciliationRequiredRef.current = true
          setRecoveryMode('check-history')
          setSendError(
            'The conversation changed, but its current history could not be confirmed. Check the conversation before sending a new message.',
          )
        }
      } else if (
        publicCode === 'PROVIDER_UNAVAILABLE' ||
        publicCode === 'CONTENT_UNAVAILABLE' ||
        publicCode === 'REJECTED' ||
        publicCode === 'TRANSIENT_FAILURE' ||
        code === 'BAD_REQUEST' ||
        code === 'NOT_FOUND'
      ) {
        pendingTurnRef.current = null
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
        setRecoveryMode('retry-turn')
        setSendError(
          publicCode === 'RATE_LIMITED' || code === 'TOO_MANY_REQUESTS'
            ? 'This message was not sent because the guide is busy. Wait a moment, then retry the same message.'
            : 'The outcome of this message is not confirmed. Retry the same message safely.',
        )
      }
      setTemporaryCharacterState('error', 1600)
    } finally {
      if (activeStreamRef.current?.operationId === turn.operationId) {
        activeStreamRef.current.unsubscribe()
        activeStreamRef.current = null
      }
      if (activeOperationRef.current === turn.operationId) {
        if (!reconciliationRequiredRef.current) setIsSending(false)
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
      recoveryMode === 'load-history'
    )
      return false
    abandonPendingOptimistic()
    const epoch = conversationEpochRef.current
    const operationId = browserUuid()
    if (!operationId) {
      setSendError(
        'This browser cannot create a private message identity. Please try another browser.',
      )
      return false
    }
    const input: ChatSendInput = {
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
    void dispatchTurn(turn, true)
    return true
  }

  function handleRetry() {
    if (!isOnline) return
    if (recoveryMode === 'load-history') {
      void retryHistoryBootstrap()
      return
    }
    const turn = pendingTurnRef.current
    if (!turn) return
    if (recoveryMode === 'check-history') {
      void (async () => {
        if (activeOperationRef.current !== null) return
        activeOperationRef.current = turn.operationId
        setIsSending(true)
        const reconciled = await reconcileTurn(turn)
        if (turnIsCurrent(turn)) {
          setIsSending(false)
          if (reconciled) {
            reconciliationRequiredRef.current = false
            pendingTurnRef.current = null
            setRecoveryMode(null)
            stoppedOperationsRef.current.delete(turn.operationId)
            setSendError(recoveryCopy[8])
          } else {
            setSendError(recoveryCopy[9])
          }
        }
        if (activeOperationRef.current === turn.operationId) activeOperationRef.current = null
      })()
    } else if (recoveryMode === 'retry-turn') void dispatchTurn(turn, false)
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
    setRecoveryMode('check-history')
    setIsSending(true)
    void reconcileTurn(turn).then((reconciled) => {
      if (!turnIsCurrent(turn)) return
      if (reconciled) {
        pendingTurnRef.current = null
        activeOperationRef.current = null
        reconciliationRequiredRef.current = false
        setRecoveryMode(null)
        setSendError(stopCopy.refreshed)
        stoppedOperationsRef.current.delete(turn.operationId)
      } else {
        activeOperationRef.current = null
        reconciliationRequiredRef.current = true
        setRecoveryMode('check-history')
        setSendError(recoveryCopy[2])
      }
      setIsSending(false)
    })
  }

  function handleDraftChange(draft = '') {
    setStableCharacterState(draft.trim() ? 'listening' : 'idle')
    if (activeOperationRef.current !== null || !pendingTurnRef.current) return
    if (reconciliationRequiredRef.current) return
    abandonPendingOptimistic()
  }

  function handleNewConversation(freshVisit = false) {
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
    const resetCopy = freshVisit
      ? 'Start a fresh visit? This clears the chat from this screen and your visit preferences. Saved Torchiko records are not deleted.'
      : recoveryCopy[10]
    if ((messages.length || freshVisit) && !window.confirm(resetCopy)) return
    const previousToken = anonymousToken
    const previousStartedAt = sessionStartedAtRef.current
    if (!startNewConversation()) {
      setSendError('We could not start a new conversation in this browser.')
      return
    }
    if (freshVisit) clearVisit()
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
            disabled={!isOnline || isSending}
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
      onRetry={recoveryMode ? handleRetry : null}
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
      visitPreferences={
        <GuestVisitPreferences
          context={visitContext}
          onChange={updateVisitContext}
          onFreshVisit={() => handleNewConversation(true)}
          disabled={!isOnline || isSending || !anonymousToken || reconciliationRequiredRef.current}
          places={messages.flatMap((message) => message.places ?? [])}
        />
      }
      onVoiceCharacterState={setStableCharacterState}
      onVoiceTranscriptLine={handleVoiceTranscriptLine}
      {...(recoveryMode === 'load-history' ? { voiceControl: null } : {})}
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
