'use client'

import { useEffect, useRef, useState } from 'react'

import { MessageBubble } from './MessageBubble'
import { PlaceCard } from './PlaceCard'

type PlaceSummary = {
  id: string
  name: string
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
  }, [messages])

  function submit() {
    const nextMessage = draft.trim()

    if (!nextMessage || isLoading) {
      return
    }

    setDraft('')
    onSend(nextMessage)
  }

  return (
    <section className="flex min-h-[50vh] flex-1 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-slate-900/70 shadow-2xl shadow-cyan-950/20 backdrop-blur">
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-5"
      >
        {messages.length === 0 ? (
          <div className="rounded-[1.5rem] border border-dashed border-white/10 bg-white/5 p-4 text-sm leading-6 text-slate-300">
            Start with a quick prompt or ask your own question.
          </div>
        ) : null}

        {messages.map((message, index) => (
          <div key={`${message.role}-${index}-${message.content.slice(0, 16)}`}>
            <MessageBubble role={message.role} content={message.content} />
            {message.places && message.places.length > 0 ? (
              <div className="mt-2 space-y-2 pl-1">
                {message.places.map((place) => (
                  <PlaceCard
                    key={place.id}
                    id={place.id}
                    name={place.name}
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
      </div>

      <div className="border-t border-white/10 bg-slate-950/80 p-3 sm:p-4">
        {errorMessage ? (
          <p className="mb-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-sm text-rose-100">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex items-end gap-3">
          <label className="sr-only" htmlFor="chat-input">
            Ask a question
          </label>
          <textarea
            id="chat-input"
            className="min-h-14 flex-1 resize-none rounded-[1.5rem] border border-white/10 bg-slate-900/80 px-4 py-3 text-[16px] leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
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
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full bg-cyan-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            disabled={isLoading || draft.trim().length === 0}
            type="button"
            onClick={submit}
          >
            {isLoading ? '...' : 'Send'}
          </button>
        </div>
      </div>
    </section>
  )
}
