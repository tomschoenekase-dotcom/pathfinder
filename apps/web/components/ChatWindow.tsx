'use client'

import { useEffect, useRef, useState } from 'react'

import { MessageBubble } from './MessageBubble'
import { PlaceCard } from './PlaceCard'
import { TypingIndicator } from './TypingIndicator'

type PlaceSummary = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
}

type Message = {
  role: 'user' | 'assistant'
  content: string
  places?: PlaceSummary[]
}

type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  isLoading: boolean
  errorMessage?: string | null
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
}

export function ChatWindow({
  messages,
  onSend,
  isLoading,
  errorMessage = null,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
}: ChatWindowProps) {
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = scrollRef.current

    if (!node) {
      return
    }

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight

    if (distanceFromBottom < 120) {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: 'smooth',
      })
    }
  }, [isLoading, messages])

  function submit() {
    const nextMessage = draft.trim()

    if (!nextMessage || isLoading) {
      return
    }

    setDraft('')
    onSend(nextMessage)
  }

  return (
    <section className="flex flex-1 flex-col overflow-hidden rounded-3xl border border-pf-light bg-pf-white shadow-sm">
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}-${message.content.slice(0, 16)}`}>
            <MessageBubble role={message.role} content={message.content} />
            {message.places && message.places.length > 0 ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {message.places.map((place) => (
                  <PlaceCard
                    key={place.id}
                    id={place.id}
                    name={place.name}
                    type={place.type}
                    photoUrl={place.photoUrl}
                    distanceMeters={place.distanceMeters}
                    lat={place.lat}
                    lng={place.lng}
                    {...(onPlaceCardClick ? { onCardClick: onPlaceCardClick } : {})}
                    {...(onPlaceCardView ? { onView: onPlaceCardView } : {})}
                    {...(onDirectionsClick ? { onDirectionsClick } : {})}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {isLoading ? <TypingIndicator /> : null}
      </div>

      <div className="border-t border-pf-light bg-pf-surface p-3 sm:p-4">
        {errorMessage ? (
          <p className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex items-end gap-3">
          <label className="sr-only" htmlFor="chat-input">
            Ask a question
          </label>
          <textarea
            id="chat-input"
            className="min-h-14 flex-1 resize-none rounded-2xl border border-pf-light bg-pf-white px-4 py-3 text-[16px] leading-6 text-pf-deep outline-none transition placeholder:text-pf-deep/30 focus:border-pf-accent focus:ring-2 focus:ring-pf-accent/20"
            disabled={isLoading}
            placeholder="Ask what is nearby, where to go next, or where to find amenities."
            rows={2}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-semibold text-white transition hover:bg-pf-accent disabled:cursor-not-allowed disabled:bg-pf-light disabled:text-pf-deep/30"
            disabled={isLoading || draft.trim().length === 0}
            type="button"
            onClick={submit}
          >
            {isLoading ? (
              <svg
                className="h-4 w-4 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    </section>
  )
}
