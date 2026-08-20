'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GuestPlaceCard } from '@pathfinder/api'
import type { GuestResponseBlock } from '@pathfinder/contracts/guest-response'
import type { GuestVisitorAction } from '@pathfinder/contracts/guest-response'

import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'

type Message = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  places?: GuestPlaceCard[]
  blocks?: GuestResponseBlock[]
}

type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  onDraftChange?: (draft: string) => void
  onRetry?: () => void
  retryLabel?: string
  isLoading: boolean
  errorMessage?: string | null
  accentColor?: string
  accentContrastColor?: string
  placeholder?: string
  initialDraft?: string
  emptyState?: ReactNode
  assistantLabel?: string
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  onMessageFeedback?: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => Promise<void>
}

export function ChatWindow({
  messages,
  onSend,
  onDraftChange,
  onRetry,
  retryLabel = 'Retry same message',
  isLoading,
  errorMessage = null,
  accentColor,
  accentContrastColor,
  placeholder = 'Ask anything about this place...',
  initialDraft = '',
  emptyState,
  assistantLabel = 'Venue guide',
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onVisitorAction,
  onMessageFeedback,
}: ChatWindowProps) {
  const [draft, setDraft] = useState(initialDraft)
  const [liveAnnouncement, setLiveAnnouncement] = useState<
    { kind: 'responding' } | { kind: 'response'; content: string } | null
  >(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const sendButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasLoadingRef = useRef(isLoading)
  const shouldRestoreComposerFocusRef = useRef(false)
  const previousMessageCountRef = useRef(messages.length)

  useEffect(() => {
    const node = scrollRef.current

    if (!node) {
      return
    }

    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight

    if (distanceFromBottom < 120) {
      const prefersReducedMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches

      node.scrollTo({
        top: node.scrollHeight,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      })
    }
  }, [isLoading, messages])

  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && shouldRestoreComposerFocusRef.current) {
      const activeElement = document.activeElement
      const focusRemainsInComposer =
        activeElement === document.body ||
        activeElement === composerRef.current ||
        activeElement === sendButtonRef.current

      if (focusRemainsInComposer) {
        composerRef.current?.focus()
      }

      shouldRestoreComposerFocusRef.current = false
    }

    wasLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    const previousMessageCount = previousMessageCountRef.current
    const hasNewMessage = messages.length > previousMessageCount
    const latestMessage = messages.at(-1)

    previousMessageCountRef.current = messages.length

    if (messages.length < previousMessageCount) {
      setLiveAnnouncement(null)
    } else if (hasNewMessage && latestMessage?.role === 'assistant') {
      setLiveAnnouncement({
        kind: 'response',
        content: latestMessage.content,
      })
    } else if (isLoading) {
      setLiveAnnouncement({ kind: 'responding' })
    } else {
      setLiveAnnouncement((current) => (current?.kind === 'responding' ? null : current))
    }
  }, [isLoading, messages])

  function submit() {
    const nextMessage = draft.trim()

    if (!nextMessage || isLoading) {
      return
    }

    setDraft('')
    shouldRestoreComposerFocusRef.current = true
    onSend(nextMessage)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] shadow-sm">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5"
        role="log"
        aria-label="Conversation"
        aria-live="off"
      >
        {messages.length === 0 && emptyState ? emptyState : null}

        {messages.map((message, index) => (
          <div key={`${message.role}-${index}-${message.content.slice(0, 16)}`}>
            <MessageBubble
              role={message.role}
              content={message.content}
              assistantLabel={assistantLabel}
              {...(message.blocks ? { blocks: message.blocks } : {})}
              {...(message.places ? { places: message.places } : {})}
              {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
              {...(onPlaceCardView ? { onPlaceCardView } : {})}
              {...(onDirectionsClick ? { onDirectionsClick } : {})}
              {...(onVisitorAction ? { onVisitorAction } : {})}
              {...(message.id && onMessageFeedback
                ? { messageId: message.id, onFeedback: onMessageFeedback }
                : {})}
              {...(message.role === 'assistant' && !isLoading ? { onChoiceSelect: onSend } : {})}
              {...(message.role === 'user' && accentColor ? { bubbleColor: accentColor } : {})}
              {...(message.role === 'user' && accentContrastColor
                ? { bubbleTextColor: accentContrastColor }
                : {})}
            />
          </div>
        ))}

        {isLoading ? <TypingIndicator /> : null}
      </div>

      <div className="sr-only" role="status" aria-atomic="true">
        {liveAnnouncement?.kind === 'responding' ? (
          <span lang="en" dir="ltr">
            {assistantLabel} is responding
          </span>
        ) : liveAnnouncement?.kind === 'response' ? (
          <>
            <span lang="en" dir="ltr">
              {assistantLabel}:{' '}
            </span>
            <span lang="" dir="auto">
              {liveAnnouncement.content}
            </span>
          </>
        ) : null}
      </div>

      <div className="border-t border-[var(--chat-border)] bg-[var(--chat-bg)] p-3 sm:p-4">
        {errorMessage ? (
          <div
            className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
            role="alert"
          >
            {errorMessage}
            {onRetry ? (
              <button
                type="button"
                disabled={isLoading}
                onClick={onRetry}
                className="ml-2 min-h-11 rounded-full border border-rose-300 bg-white px-4 font-semibold text-rose-800 disabled:opacity-50"
              >
                {retryLabel}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex items-end gap-3">
          <label className="sr-only" htmlFor="chat-input">
            Ask a question
          </label>
          <textarea
            ref={composerRef}
            id="chat-input"
            lang=""
            dir="auto"
            className="min-h-14 flex-1 resize-none rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 py-3 text-[16px] leading-6 text-[var(--chat-text)] outline-none transition placeholder:text-[var(--chat-text-muted)] focus:border-[var(--chat-accent)] focus:ring-2 focus:ring-[var(--chat-accent)]/20"
            disabled={isLoading}
            placeholder={placeholder}
            rows={2}
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value
              setDraft(nextDraft)
              onDraftChange?.(nextDraft)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            ref={sendButtonRef}
            style={{
              backgroundColor: !isLoading && draft.trim().length > 0 ? accentColor : undefined,
              color: !isLoading && draft.trim().length > 0 ? accentContrastColor : undefined,
            }}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent bg-[var(--chat-accent)] px-5 text-sm font-semibold text-[var(--chat-accent-contrast)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:border-[var(--chat-border)] disabled:bg-[var(--chat-card)] disabled:text-[var(--chat-text-muted)]"
            disabled={isLoading || draft.trim().length === 0}
            type="button"
            aria-label={isLoading ? 'Sending message' : 'Send message'}
            onClick={submit}
          >
            {isLoading ? (
              <svg
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
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
