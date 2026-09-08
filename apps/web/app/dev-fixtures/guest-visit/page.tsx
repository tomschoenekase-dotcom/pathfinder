'use client'

import { useState } from 'react'

import { GuestVisitPreferences } from '../../../components/GuestVisitPreferences'
import { VenueChatShell } from '../../../components/VenueChatShell'
import { useGuestVisitContext } from '../../../hooks/useGuestVisitContext'
import type { ChatMessage, VenueSummary } from '../../../components/venue-chat-types'

const venue: VenueSummary = {
  id: 'guest-visit-fixture-venue',
  name: 'Great Lakes Museum',
  description: 'A small museum with trains, local history, and quiet galleries.',
  category: 'Museum',
  guideMode: 'non_location',
  defaultCenterLat: null,
  defaultCenterLng: null,
  aiGuideName: 'Milo',
  chatTheme: 'paper',
  chatAccentColor: null,
  chatFont: 'jakarta',
  chatLogoUrl: null,
  chatBannerUrl: null,
}

const initialMessages: ChatMessage[] = [
  { id: 'fixture-user', role: 'user', content: 'I want to see the trains.' },
  {
    id: 'fixture-assistant',
    role: 'assistant',
    content: 'Start with the North Gallery, then follow the signs to the lake room.',
  },
]

export default function GuestVisitFixture() {
  const [messages, setMessages] = useState(initialMessages)
  const [disabled, setDisabled] = useState(false)
  const visit = useGuestVisitContext(venue.id)

  function clearChat() {
    setMessages([])
  }

  function startFreshVisit() {
    visit.clearVisit()
    setMessages([])
  }

  return (
    <main data-fixture="guest-visit" className="min-h-screen bg-[var(--chat-bg)]">
      <div className="mx-auto max-w-3xl px-3 py-3 sm:px-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
            Disposable visit context fixture
          </p>
          <button
            type="button"
            onClick={() => setDisabled((current) => !current)}
            className="min-h-11 rounded-full border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700"
          >
            {disabled ? 'Enable preference editing' : 'Pause preference editing'}
          </button>
        </div>
        <VenueChatShell
          venue={venue}
          venueSlug="guest-visit-fixture"
          presentation="standalone"
          messages={messages}
          isSending={false}
          sendError={null}
          anonymousToken="guest-visit-fixture-token"
          language="English"
          setLanguage={() => undefined}
          initialDraft=""
          location={{ lat: null, lng: null, permission: 'prompt', refresh: () => undefined }}
          onSend={() => undefined}
          onNewConversation={clearChat}
          onPlaceView={() => undefined}
          onPlaceClick={() => undefined}
          onDirections={() => undefined}
          voiceControl={null}
          visitContext={visit.context}
          visitPreferences={
            <GuestVisitPreferences
              context={visit.context}
              places={[
                { id: 'north-gallery', name: 'North Gallery' },
                { id: 'lake-room', name: 'Lake Room' },
                { id: 'train-hall', name: 'Train Hall' },
              ]}
              onChange={visit.updateContext}
              onFreshVisit={startFreshVisit}
              disabled={disabled}
            />
          }
        />
      </div>
    </main>
  )
}
