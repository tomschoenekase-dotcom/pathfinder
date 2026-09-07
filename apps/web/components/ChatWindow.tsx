'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GuestPlaceCard } from '@pathfinder/api'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { GuestResponseBlock } from '@pathfinder/contracts/guest-response'
import type { GuestVisitorAction } from '@pathfinder/contracts/guest-response'

import { MessageBubble } from './MessageBubble'
import styles from './visitor-chat.module.css'
import { TypingIndicator } from './TypingIndicator'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

type Message = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  places?: GuestPlaceCard[]
  blocks?: GuestResponseBlock[]
  voiceDelivery?: 'CAPTURED' | 'INTERRUPTED'
  voicePersistence?: 'PENDING' | 'SAVED' | 'UNCONFIRMED'
}

type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void
  onRequestMore?: () => void
  requestMoreLabel?: string
  onDraftChange?: (draft: string) => void
  onRetry?: () => void
  retryLabel?: string
  onStopResponse?: () => void
  stopResponseLabel?: string
  conversationLocked?: boolean
  isLoading: boolean
  errorMessage?: string | null
  accentColor?: string
  accentContrastColor?: string
  placeholder?: string
  initialDraft?: string
  emptyState?: ReactNode
  conversationTools?: ReactNode
  assistantLabel?: string
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  onMessageFeedback?: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => Promise<void>
  isOnline?: boolean
  language?: SupportedChatLanguage
}

export function ChatWindow({
  messages,
  onSend,
  onRequestMore,
  requestMoreLabel = 'Tell me more',
  onDraftChange,
  onRetry,
  retryLabel = 'Retry same message',
  onStopResponse,
  stopResponseLabel = 'Stop response',
  conversationLocked = false,
  isLoading,
  errorMessage = null,
  accentColor,
  accentContrastColor,
  placeholder = 'Ask anything about this place...',
  initialDraft = '',
  emptyState,
  conversationTools,
  assistantLabel = 'Venue guide',
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onVisitorAction,
  onMessageFeedback,
  isOnline = true,
  language = 'English',
}: ChatWindowProps) {
  const presentation = getChatLanguagePresentation(language)
  const [
    ,
    ,
    ,
    conversationLabel,
    ,
    askQuestionLabel,
    reconnectLabel,
    sendingLabel,
    sendMessageLabel,
    sendLabel,
    respondingLabel,
  ] = getVisitorUiCopy(language).shell
  const [draft, setDraft] = useState(initialDraft)
  const composerId = useId()
  const [liveAnnouncement, setLiveAnnouncement] = useState<
    { kind: 'responding' } | { kind: 'response'; content: string } | null
  >(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const sendButtonRef = useRef<HTMLButtonElement | null>(null)
  const wasLoadingRef = useRef(isLoading)
  const announcementWasLoadingRef = useRef(isLoading)
  const shouldRestoreComposerFocusRef = useRef(false)
  const previousMessageCountRef = useRef(messages.length)
  const followLatestRef = useRef(true)

  useEffect(() => {
    const node = composerRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(144, Math.max(44, node.scrollHeight))}px`
  }, [draft])

  useEffect(() => {
    const node = scrollRef.current

    if (!node) {
      return
    }

    if (messages.length < previousMessageCountRef.current) {
      followLatestRef.current = true
    }

    if (followLatestRef.current) {
      // Instant follow avoids animation events racing the reader's scroll position.
      node.scrollTo({
        top: messages.length === 0 ? 0 : node.scrollHeight,
        behavior: 'auto',
      })
    }
  }, [errorMessage, isLoading, messages])

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
    const responseCompleted = announcementWasLoadingRef.current && !isLoading

    previousMessageCountRef.current = messages.length
    announcementWasLoadingRef.current = isLoading

    if (messages.length < previousMessageCount) {
      followLatestRef.current = true
      setLiveAnnouncement(null)
    } else if (responseCompleted && latestMessage?.role === 'assistant') {
      setLiveAnnouncement({
        kind: 'response',
        content: latestMessage.content,
      })
    } else if (isLoading) {
      setLiveAnnouncement({ kind: 'responding' })
    } else if (hasNewMessage && latestMessage?.role === 'assistant') {
      setLiveAnnouncement({
        kind: 'response',
        content: latestMessage.content,
      })
    } else {
      setLiveAnnouncement((current) => (current?.kind === 'responding' ? null : current))
    }
  }, [isLoading, messages])

  function submit() {
    const nextMessage = draft.trim()

    if (!nextMessage || isLoading || !isOnline || conversationLocked) {
      return
    }

    setDraft('')
    followLatestRef.current = true
    shouldRestoreComposerFocusRef.current = true
    onSend(nextMessage)
  }

  return (
    <section className={`${styles.window} flex min-h-0 flex-1 flex-col overflow-hidden`}>
      <div
        ref={scrollRef}
        className={`${styles.conversation} min-h-0 flex-1 space-y-5 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--chat-accent)]`}
        role="log"
        aria-label={conversationLabel}
        aria-live="off"
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget
          followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
        }}
      >
        {conversationTools}
        {messages.length === 0 && emptyState ? emptyState : null}

        {messages.map((message, index) => (
          <div key={message.id ?? `${message.role}-${index}`}>
            <MessageBubble
              role={message.role}
              content={message.content}
              assistantLabel={assistantLabel}
              language={language}
              {...(message.blocks ? { blocks: message.blocks } : {})}
              {...(message.places ? { places: message.places } : {})}
              {...(message.voiceDelivery ? { voiceDelivery: message.voiceDelivery } : {})}
              {...(message.voicePersistence ? { voicePersistence: message.voicePersistence } : {})}
              {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
              {...(onPlaceCardView ? { onPlaceCardView } : {})}
              {...(onDirectionsClick ? { onDirectionsClick } : {})}
              {...(onVisitorAction ? { onVisitorAction } : {})}
              {...(message.id && !message.voiceDelivery && onMessageFeedback
                ? { messageId: message.id, onFeedback: onMessageFeedback }
                : {})}
              {...(message.role === 'assistant' && !isLoading && isOnline && !conversationLocked
                ? { onChoiceSelect: onSend }
                : {})}
              {...(message.role === 'user' && accentColor ? { bubbleColor: accentColor } : {})}
              {...(message.role === 'user' && accentContrastColor
                ? { bubbleTextColor: accentContrastColor }
                : {})}
            />
          </div>
        ))}

        {onRequestMore &&
        !isLoading &&
        messages.at(-1)?.role === 'assistant' &&
        !messages.at(-1)?.voiceDelivery ? (
          <div className="flex justify-start pl-1">
            <button
              type="button"
              onClick={onRequestMore}
              disabled={isLoading || !isOnline || conversationLocked}
              className="min-h-11 rounded-full border border-[var(--chat-border)] bg-[var(--chat-bg)] px-4 text-sm font-semibold text-[var(--chat-accent-text)] transition hover:border-[var(--chat-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              {requestMoreLabel}
            </button>
          </div>
        ) : null}

        {isLoading && messages.at(-1)?.role !== 'assistant' ? <TypingIndicator /> : null}

        {errorMessage ? (
          <div
            className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-5 text-rose-700"
            role="alert"
          >
            <p>{errorMessage}</p>
            {onRetry ? (
              <button
                type="button"
                disabled={isLoading || !isOnline}
                onClick={onRetry}
                className="mt-2 min-h-11 rounded-full border border-rose-300 bg-white px-4 font-semibold text-rose-800 disabled:opacity-50"
              >
                {retryLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="sr-only" role="status" aria-atomic="true">
        {liveAnnouncement?.kind === 'responding' ? (
          <span lang={presentation.code} dir={presentation.direction}>
            {assistantLabel} {respondingLabel}
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

      <div className={styles.composer}>
        <div className={styles.composerField}>
          <label
            className="sr-only"
            htmlFor={composerId}
            lang={presentation.code}
            dir={presentation.direction}
          >
            {askQuestionLabel}
          </label>
          <textarea
            ref={composerRef}
            id={composerId}
            lang=""
            dir="auto"
            className="min-h-14 flex-1 resize-none rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 py-3 text-[16px] leading-6 text-[var(--chat-text)] outline-none transition placeholder:text-[var(--chat-text-muted)] focus:border-[var(--chat-accent)] focus:ring-2 focus:ring-[var(--chat-accent)]/20"
            enterKeyHint="send"
            placeholder={placeholder}
            rows={1}
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value
              setDraft(nextDraft)
              onDraftChange?.(nextDraft)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <button
            ref={sendButtonRef}
            style={{
              backgroundColor:
                isOnline && !isLoading && draft.trim().length > 0 ? accentColor : undefined,
              color:
                isOnline && !isLoading && draft.trim().length > 0 ? accentContrastColor : undefined,
            }}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent bg-[var(--chat-accent)] px-5 text-sm font-semibold text-[var(--chat-accent-contrast)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:border-[var(--chat-border)] disabled:bg-[var(--chat-card)] disabled:text-[var(--chat-text-muted)]"
            disabled={
              !isOnline ||
              conversationLocked ||
              (isLoading ? !onStopResponse : draft.trim().length === 0)
            }
            type="button"
            aria-label={
              !isOnline
                ? reconnectLabel
                : isLoading
                  ? onStopResponse
                    ? stopResponseLabel
                    : sendingLabel
                  : sendMessageLabel
            }
            onClick={isLoading ? onStopResponse : submit}
          >
            {isLoading && onStopResponse ? (
              <span className="text-base leading-none" aria-hidden="true">
                ■
              </span>
            ) : isLoading ? (
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
              <>
                <span className="hidden sm:inline">{sendLabel}</span>
                <svg
                  className="h-5 w-5 sm:hidden"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M12 19V5m-6 6 6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </section>
  )
}
