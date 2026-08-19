'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'
import type { inferRouterInputs } from '@trpc/server'
import type { AppRouter } from '@pathfinder/api'

import { useGeolocation } from '../hooks/useGeolocation'
import { useSession } from '../hooks/useSession'
import { useVenueChatAnalytics } from '../hooks/useVenueChatAnalytics'
import { useVisitorId } from '../hooks/useVisitorId'
import { classifyPublicVenueLookupError } from '../lib/public-venue-error'
import { browserUuid } from '../lib/browser-uuid'
import { useTRPCClient } from '../lib/trpc'
import { getStoredLanguage, SUPPORTED_LANGUAGES } from './LanguagePicker'
import { VenueChatError, VenueChatSkeleton } from './VenueChatStates'
import { VenueChatShell } from './VenueChatShell'
import { VenueTemporarilyUnavailable } from './VenueTemporarilyUnavailable'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'

type VenueChatExperienceProps = {
  venueSlug: string
  presentation?: VenueChatPresentation
  initialDraft?: string
  secondLayerKey?: string
}

type ChatSendInput = inferRouterInputs<AppRouter>['chat']['send']
type PendingTurn = {
  operationId: string
  input: ChatSendInput
  epoch: number
  venueId: string
  anonymousToken: string
}

function trpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = error as { code?: unknown; data?: { code?: unknown } }
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.data?.code
  return typeof code === 'string' ? code : null
}

export function VenueChatExperience({
  venueSlug,
  presentation = 'standalone',
  initialDraft = '',
  secondLayerKey,
}: VenueChatExperienceProps) {
  const client = useTRPCClient()
  const [venueState, setVenueState] = useState<{ slug: string; venue: VenueSummary | null } | null>(
    null,
  )
  const venue = venueState?.slug === venueSlug ? venueState.venue : null
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isBooting, setIsBooting] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [characterState, setCharacterState] = useState<CharacterState>('idle')
  const [pageError, setPageError] = useState<string | null>(null)
  const [isVenueUnavailable, setIsVenueUnavailable] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [recoveryMode, setRecoveryMode] = useState<'retry-turn' | 'check-history' | null>(null)
  const [language, setLanguage] = useState<SupportedChatLanguage>(() => {
    const stored = getStoredLanguage()
    return SUPPORTED_LANGUAGES.some((entry) => entry.label === stored)
      ? (stored as SupportedChatLanguage)
      : 'English'
  })
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const conversationEpochRef = useRef(0)
  const sendingEpochRef = useRef<number | null>(null)
  const activeOperationRef = useRef<string | null>(null)
  const pendingTurnRef = useRef<PendingTurn | null>(null)
  const currentVenueIdRef = useRef<string | null>(null)
  const currentAnonymousTokenRef = useRef<string | null>(null)
  const reconciliationRequiredRef = useRef(false)
  const characterResetTimerRef = useRef<number | null>(null)
  const { lat, lng, permission, refresh } = useGeolocation(
    Boolean(venue && venue.guideMode !== 'non_location'),
  )
  const experienceStorageScope = secondLayerKey ? `second-layer:${secondLayerKey}` : 'public'
  const { anonymousToken, identityUnavailable, setSessionId, startNewConversation } = useSession(
    venue?.id ?? '',
    experienceStorageScope,
  )
  const visitorId = useVisitorId()
  currentVenueIdRef.current = venue?.id ?? null
  currentAnonymousTokenRef.current = anonymousToken
  const { endSession, resetAnalytics, sessionStartedAtRef, trackPlaceEvent, viewedPlaceIdsRef } =
    useVenueChatAnalytics({
      venue: secondLayerKey ? null : venue,
      anonymousToken: secondLayerKey ? null : anonymousToken,
      visitorId,
    })

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

  useEffect(() => {
    if (venue && identityUnavailable)
      setSendError('This browser cannot create a private chat session.')
  }, [identityUnavailable, venue])

  useEffect(() => {
    let disposed = false
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
      setIsSending(false)
      activeOperationRef.current = null
      pendingTurnRef.current = null
      sendingEpochRef.current = null
      lastSyncedPosRef.current = null
      resetAnalytics()
      try {
        const result = await client.venue.getBySlug.query({
          slug: venueSlug,
          ...(secondLayerKey ? { secondLayerKey } : {}),
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
            const history = await client.chat.history.query({
              venueId: result.id,
              anonymousToken: token,
              ...(secondLayerKey ? { secondLayerKey } : {}),
            })
            if (!disposed && conversationEpochRef.current === epoch && history.messages.length)
              setMessages(history.messages)
          } catch {
            // History is optional; a failed read starts an empty conversation.
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
    }
  }, [
    client,
    experienceStorageScope,
    resetAnalytics,
    secondLayerKey,
    setTemporaryCharacterState,
    venueSlug,
  ])

  useEffect(() => {
    let disposed = false
    async function ensureSession() {
      if (!venue || !anonymousToken) return
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
  }, [anonymousToken, client, lat, lng, secondLayerKey, setSessionId, venue, visitorId])

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

  async function reconcileTurn(turn: PendingTurn): Promise<boolean> {
    try {
      const history = await client.chat.history.query({
        venueId: turn.venueId,
        anonymousToken: turn.anonymousToken,
        ...(secondLayerKey ? { secondLayerKey } : {}),
      })
      if (!turnIsCurrent(turn)) return false
      setMessages(history.messages)
      reconciliationRequiredRef.current = false
      return true
    } catch {
      // Retain the frozen operation. A failed reconciliation must not invent an empty history.
      return false
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
    sendingEpochRef.current = turn.epoch
    try {
      const result = await client.chat.send.mutate(turn.input)
      if (!turnIsCurrent(turn)) return
      const response = result.response
      const resultPlaces = result.places
      if (typeof response !== 'string' || !Array.isArray(resultPlaces)) {
        throw new Error('The completed chat turn response was incomplete.')
      }
      setMessages((current) => [
        ...current.map((message) =>
          message.pendingOperationId === turn.operationId
            ? { role: message.role, content: message.content }
            : message,
        ),
        {
          role: 'assistant',
          content: response,
          places: resultPlaces as NonNullable<ChatMessage['places']>,
        },
      ])
      setSessionId(result.sessionId)
      pendingTurnRef.current = null
      setRecoveryMode(null)
      setTemporaryCharacterState('success', 900)
    } catch (error) {
      if (!turnIsCurrent(turn)) return
      const code = trpcErrorCode(error)
      if (code === 'CONFLICT' || code === 'PRECONDITION_FAILED') {
        const reconciled = await reconcileTurn(turn)
        if (!turnIsCurrent(turn)) return
        if (reconciled) {
          pendingTurnRef.current = null
          setRecoveryMode(null)
          setSendError(
            code === 'PRECONDITION_FAILED'
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
      } else if (code === 'BAD_REQUEST' || code === 'NOT_FOUND') {
        setRecoveryMode(null)
        setSendError('This message could not be accepted. Review it before sending a new message.')
      } else {
        setRecoveryMode('retry-turn')
        setSendError(
          code === 'TOO_MANY_REQUESTS'
            ? 'This message is still being checked. Wait a moment, then retry the same message.'
            : 'The outcome of this message is not confirmed. Retry the same message safely.',
        )
      }
      setTemporaryCharacterState('error', 1600)
    } finally {
      if (sendingEpochRef.current === turn.epoch) sendingEpochRef.current = null
      if (turnScopeIsCurrent(turn)) setIsSending(false)
      if (activeOperationRef.current === turn.operationId) activeOperationRef.current = null
    }
  }

  function handleSend(raw: string) {
    const message = raw.trim()
    if (
      !venue ||
      !anonymousToken ||
      !message ||
      activeOperationRef.current !== null ||
      reconciliationRequiredRef.current
    )
      return
    abandonPendingOptimistic()
    const epoch = conversationEpochRef.current
    const operationId = browserUuid()
    if (!operationId) {
      setSendError(
        'This browser cannot create a private message identity. Please try another browser.',
      )
      return
    }
    const input: ChatSendInput = {
      operationId,
      venueId: venue.id,
      anonymousToken,
      ...(secondLayerKey ? { secondLayerKey } : {}),
      ...(visitorId ? { visitorId } : {}),
      message,
      ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null ? { lat, lng } : {}),
      ...(language === 'English' ? {} : { language }),
    }
    const turn = { operationId, input, epoch, venueId: venue.id, anonymousToken }
    pendingTurnRef.current = turn
    void dispatchTurn(turn, true)
  }

  function handleRetry() {
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
            pendingTurnRef.current = null
            setRecoveryMode(null)
            setSendError(
              'Conversation refreshed. The unconfirmed message will not be retried; you may send a new message.',
            )
          } else {
            setSendError('The conversation still could not be confirmed. Try checking again.')
          }
        }
        if (activeOperationRef.current === turn.operationId) activeOperationRef.current = null
      })()
    } else if (recoveryMode === 'retry-turn') void dispatchTurn(turn, false)
  }

  function handleDraftChange(draft = '') {
    setStableCharacterState(draft.trim() ? 'listening' : 'idle')
    if (
      activeOperationRef.current !== null ||
      !pendingTurnRef.current ||
      reconciliationRequiredRef.current
    )
      return
    abandonPendingOptimistic()
  }

  function handleNewConversation() {
    if (!venue || !anonymousToken || isSending || activeOperationRef.current !== null) return
    if (
      messages.length &&
      !window.confirm(
        'Start a new conversation? The current chat will leave this screen, but it will not be deleted from Torchiko records.',
      )
    )
      return
    const previousToken = anonymousToken
    const previousStartedAt = sessionStartedAtRef.current
    if (!startNewConversation()) {
      setSendError('We could not start a new conversation in this browser.')
      return
    }
    conversationEpochRef.current += 1
    sendingEpochRef.current = null
    activeOperationRef.current = null
    pendingTurnRef.current = null
    setMessages([])
    setSendError(null)
    setRecoveryMode(null)
    reconciliationRequiredRef.current = false
    lastSyncedPosRef.current = null
    resetAnalytics()
    setTemporaryCharacterState('attention', 900)
    endSession(venue.id, previousToken, previousStartedAt)
  }

  if (isBooting || venueState?.slug !== venueSlug) return <VenueChatSkeleton />
  if (isVenueUnavailable)
    return <VenueTemporarilyUnavailable showHomeLink={presentation === 'standalone'} />
  if (!venue)
    return (
      <VenueChatError
        message={pageError ?? 'This venue link is not active.'}
        presentation={presentation}
      />
    )

  return (
    <VenueChatShell
      venue={venue}
      venueSlug={venueSlug}
      presentation={presentation}
      messages={messages}
      isSending={isSending}
      sendError={sendError}
      anonymousToken={anonymousToken}
      language={language}
      setLanguage={setLanguage}
      initialDraft={initialDraft}
      characterState={characterState}
      location={{ lat, lng, permission, refresh }}
      onSend={(message) => {
        handleSend(message)
      }}
      onDraftChange={handleDraftChange}
      onRetry={recoveryMode ? handleRetry : null}
      retryLabel={recoveryMode === 'check-history' ? 'Check conversation' : 'Retry same message'}
      onNewConversation={handleNewConversation}
      onPlaceView={(placeId) => {
        if (!viewedPlaceIdsRef.current.has(placeId)) {
          viewedPlaceIdsRef.current.add(placeId)
          trackPlaceEvent('place_card.viewed', placeId)
        }
      }}
      onPlaceClick={(placeId) => trackPlaceEvent('place_card.clicked', placeId)}
      onDirections={(placeId) => trackPlaceEvent('directions.opened', placeId)}
    />
  )
}
