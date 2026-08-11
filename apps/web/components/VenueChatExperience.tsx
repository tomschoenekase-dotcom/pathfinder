'use client'

import { useEffect, useRef, useState } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { useGeolocation } from '../hooks/useGeolocation'
import { useSession } from '../hooks/useSession'
import { useVenueChatAnalytics } from '../hooks/useVenueChatAnalytics'
import { useVisitorId } from '../hooks/useVisitorId'
import { classifyPublicVenueLookupError } from '../lib/public-venue-error'
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
}

export function VenueChatExperience({
  venueSlug,
  presentation = 'standalone',
  initialDraft = '',
}: VenueChatExperienceProps) {
  const client = useTRPCClient()
  const [venueState, setVenueState] = useState<{ slug: string; venue: VenueSummary | null } | null>(
    null,
  )
  const venue = venueState?.slug === venueSlug ? venueState.venue : null
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isBooting, setIsBooting] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [isVenueUnavailable, setIsVenueUnavailable] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [language, setLanguage] = useState<SupportedChatLanguage>(() => {
    const stored = getStoredLanguage()
    return SUPPORTED_LANGUAGES.some((entry) => entry.label === stored)
      ? (stored as SupportedChatLanguage)
      : 'English'
  })
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const conversationEpochRef = useRef(0)
  const sendingEpochRef = useRef<number | null>(null)
  const { lat, lng, permission, refresh } = useGeolocation(
    Boolean(venue && venue.guideMode !== 'non_location'),
  )
  const { anonymousToken, identityUnavailable, setSessionId, startNewConversation } = useSession(
    venue?.id ?? '',
  )
  const visitorId = useVisitorId()
  const { endSession, resetAnalytics, sessionStartedAtRef, trackPlaceEvent, viewedPlaceIdsRef } =
    useVenueChatAnalytics({ venue, anonymousToken, visitorId })

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
      setIsSending(false)
      sendingEpochRef.current = null
      lastSyncedPosRef.current = null
      resetAnalytics()
      try {
        const result = await client.venue.getBySlug.query({ slug: venueSlug })
        if (disposed || conversationEpochRef.current !== epoch) return
        setVenueState({ slug: venueSlug, venue: result })
        let token: string | null = null
        try {
          token = window.sessionStorage.getItem(`pathfinder_session_${result.id}`)
        } catch {
          // The session hook retains its in-memory privacy boundary.
        }
        if (token) {
          try {
            const history = await client.chat.history.query({
              venueId: result.id,
              anonymousToken: token,
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
  }, [client, resetAnalytics, venueSlug])

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
  }, [anonymousToken, client, lat, lng, setSessionId, venue, visitorId])

  async function handleSend(raw: string) {
    const message = raw.trim()
    if (!venue || !anonymousToken || !message || isSending) return
    setSendError(null)
    setIsSending(true)
    setMessages((current) => [...current, { role: 'user', content: message }])
    const epoch = conversationEpochRef.current
    sendingEpochRef.current = epoch
    try {
      const result = await client.chat.send.mutate({
        venueId: venue.id,
        anonymousToken,
        ...(visitorId ? { visitorId } : {}),
        message,
        ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null ? { lat, lng } : {}),
        ...(language === 'English' ? {} : { language }),
      })
      if (conversationEpochRef.current === epoch) {
        setMessages((current) => [
          ...current,
          { role: 'assistant', content: result.response, places: result.places },
        ])
        setSessionId(result.sessionId)
      }
    } catch (error) {
      if (conversationEpochRef.current !== epoch) return
      if (classifyPublicVenueLookupError(error) === 'temporarily-unavailable')
        setIsVenueUnavailable(true)
      else setSendError('That message did not send. Please try again.')
    } finally {
      if (sendingEpochRef.current === epoch) {
        sendingEpochRef.current = null
        setIsSending(false)
      }
    }
  }

  function handleNewConversation() {
    if (!venue || !anonymousToken || isSending) return
    if (
      messages.length &&
      !window.confirm(
        'Start a new conversation? The current chat will leave this screen, but it will not be deleted from PathFinder records.',
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
    setMessages([])
    setSendError(null)
    lastSyncedPosRef.current = null
    resetAnalytics()
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
      location={{ lat, lng, permission, refresh }}
      onSend={(message) => {
        void handleSend(message)
      }}
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
