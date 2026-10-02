'use client'

import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GuestPlaceCard } from '@pathfinder/api'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { GuestResponseBlock } from '@pathfinder/contracts/guest-response'
import type { GuestVisitorAction } from '@pathfinder/contracts/guest-response'
import type { GuestReplyKind } from '@pathfinder/contracts/guest-reply-kind'

import { MessageBubble, type MessageSurfaces } from './MessageBubble'
import styles from './visitor-chat.module.css'
import { TypingIndicator } from './TypingIndicator'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'
import { shouldDismissKeyboardOnSubmit } from '../hooks/useChatViewportHeight'

type Message = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  replyKind?: GuestReplyKind
  places?: GuestPlaceCard[]
  blocks?: GuestResponseBlock[]
  voiceDelivery?: 'CAPTURED' | 'INTERRUPTED'
  voicePersistence?: 'PENDING' | 'SAVED' | 'UNCONFIRMED'
}

type ChatWindowProps = {
  messages: Message[]
  onSend: (message: string) => void | boolean
  onRequestMore?: () => void
  requestMoreLabel?: string
  onDraftChange?: (draft: string) => void
  onRetry?: () => void
  retryLabel?: string
  onStopResponse?: () => void
  stopResponseLabel?: string
  conversationLocked?: boolean
  sendDisabled?: boolean
  restoringStatusLabel?: string
  isLoading: boolean
  errorMessage?: string | null
  accentColor?: string
  accentContrastColor?: string
  placeholder?: string
  initialDraft?: string
  prefill?: { sequence: number; ask: string } | null
  draftStorageKey?: string | null
  emptyState?: ReactNode
  conversationTools?: ReactNode
  composerVoiceControl?: ReactNode
  voiceCaption?: { text: string; interrupted: boolean } | null
  voiceCaptionAnnouncement?: string | null
  voiceCaptionAnnouncementKey?: number
  assistantLabel?: string
  /** Visible speaker labels, used when neither speaker has a bubble. */
  speakerLabels?: { guide: string }
  surfaces?: MessageSurfaces
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  isOnline?: boolean
  language?: SupportedChatLanguage
  locationAware?: boolean
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
  sendDisabled = false,
  restoringStatusLabel,
  isLoading,
  errorMessage = null,
  accentColor,
  accentContrastColor,
  placeholder = 'Ask anything about this place...',
  initialDraft = '',
  prefill = null,
  draftStorageKey = null,
  emptyState,
  conversationTools,
  composerVoiceControl,
  voiceCaption = null,
  voiceCaptionAnnouncement = null,
  voiceCaptionAnnouncementKey = 0,
  assistantLabel = 'Venue guide',
  speakerLabels,
  surfaces,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onVisitorAction,
  isOnline = true,
  language = 'English',
  locationAware = false,
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
  const draftScopeRef = useRef(draftStorageKey)
  const composerId = useId()
  const [liveAnnouncement, setLiveAnnouncement] = useState<
    { kind: 'responding' } | { kind: 'response'; content: string } | null
  >(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const sendButtonRef = useRef<HTMLButtonElement | null>(null)
  const sendTouchStartRef = useRef<{ id: number; x: number; y: number } | null>(null)
  const lastSendTouchEndAtRef = useRef(0)
  const wasLoadingRef = useRef(isLoading)
  const announcementWasLoadingRef = useRef(false)
  const shouldRestoreComposerFocusRef = useRef(false)
  const previousMessageCountRef = useRef(messages.length)
  const followLatestRef = useRef(true)

  useEffect(() => {
    const previousScope = draftScopeRef.current
    draftScopeRef.current = draftStorageKey
    if (!draftStorageKey) {
      if (previousScope) setDraft('')
      return
    }
    try {
      const storedDraft = window.sessionStorage.getItem(draftStorageKey)
      if (storedDraft !== null) setDraft(storedDraft)
      else if (previousScope && previousScope !== draftStorageKey) setDraft('')
      else if (!previousScope && draft) window.sessionStorage.setItem(draftStorageKey, draft)
    } catch {
      // Private browsing can make session storage unavailable; keep the in-memory draft.
    }
  }, [draftStorageKey, draft])

  useEffect(() => {
    if (!prefill) return
    setDraft(prefill.ask)
    rememberDraft(prefill.ask)
    onDraftChange?.(prefill.ask)
    // Each host prefill carries a new sequence. Other renders cannot overwrite visitor typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.sequence])

  function rememberDraft(nextDraft: string) {
    if (!draftStorageKey) return
    try {
      if (nextDraft) window.sessionStorage.setItem(draftStorageKey, nextDraft)
      else window.sessionStorage.removeItem(draftStorageKey)
    } catch {
      // Typing stays available if browser storage is unavailable.
    }
  }

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
  }, [errorMessage, isLoading, messages, voiceCaption?.text, voiceCaption?.interrupted])

  useEffect(() => {
    if (wasLoadingRef.current && !isLoading && shouldRestoreComposerFocusRef.current) {
      const activeElement = document.activeElement
      const focusRemainsInComposer =
        activeElement === document.body ||
        activeElement === composerRef.current ||
        activeElement === sendButtonRef.current

      if (focusRemainsInComposer) {
        composerRef.current?.focus({ preventScroll: true })
      }

      shouldRestoreComposerFocusRef.current = false
    }

    wasLoadingRef.current = isLoading
  }, [isLoading])

  useEffect(() => {
    const previousMessageCount = previousMessageCountRef.current
    const hasNewMessage = messages.length > previousMessageCount
    const latestMessage = messages.at(-1)
    const responseStarted = !announcementWasLoadingRef.current && isLoading
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
    } else if (responseStarted) {
      setLiveAnnouncement({ kind: 'responding' })
    } else if (!isLoading && hasNewMessage && latestMessage?.role === 'assistant') {
      setLiveAnnouncement({
        kind: 'response',
        content: latestMessage.content,
      })
    } else if (!isLoading) {
      setLiveAnnouncement((current) => (current?.kind === 'responding' ? null : current))
    }
  }, [isLoading, messages])

  function submit() {
    const nextMessage = draft.trim()

    if (!nextMessage || isLoading || !isOnline || conversationLocked || sendDisabled) {
      return
    }

    // A parent can reject a send synchronously while session/history state settles.
    // In that case the visitor keeps the text they already wrote.
    if (onSend(nextMessage) === false) return

    setDraft('')
    rememberDraft('')
    followLatestRef.current = true
    // On a phone the send itself dismisses the software keyboard, in this same interaction, so
    // the composer settles back down while the answer loads; nothing refocuses it afterwards.
    // A desktop or hardware keyboard keeps focus in the composer for the next question.
    const field = composerRef.current
    if (shouldDismissKeyboardOnSubmit(field)) {
      field?.blur()
      shouldRestoreComposerFocusRef.current = false
    } else {
      shouldRestoreComposerFocusRef.current = true
    }
  }

  return (
    <section className={`${styles.window} flex min-h-0 flex-1 flex-col overflow-hidden`}>
      {restoringStatusLabel ? (
        <p className="flex-shrink-0 px-5 py-2 text-sm text-[var(--chat-text-muted)]" role="status">
          {restoringStatusLabel}
        </p>
      ) : null}
      <div
        ref={scrollRef}
        data-chat-conversation
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
        {messages.length === 0 && emptyState ? emptyState : null}
        {conversationTools ? <div className={styles.tools}>{conversationTools}</div> : null}

        {messages.map((message, index) => (
          <div key={message.id ?? `${message.role}-${index}`}>
            <MessageBubble
              role={message.role}
              content={message.content}
              assistantLabel={assistantLabel}
              {...(speakerLabels ? { visibleGuideLabel: speakerLabels.guide } : {})}
              {...(surfaces ? { surfaces } : {})}
              language={language}
              locationAware={locationAware}
              {...(message.blocks ? { blocks: message.blocks } : {})}
              {...(message.places ? { places: message.places } : {})}
              {...(message.voiceDelivery ? { voiceDelivery: message.voiceDelivery } : {})}
              {...(message.voicePersistence ? { voicePersistence: message.voicePersistence } : {})}
              {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
              {...(onPlaceCardView ? { onPlaceCardView } : {})}
              {...(onDirectionsClick ? { onDirectionsClick } : {})}
              {...(onVisitorAction ? { onVisitorAction } : {})}
              {...(message.role === 'assistant' &&
              !isLoading &&
              isOnline &&
              !conversationLocked &&
              !sendDisabled
                ? { onChoiceSelect: onSend }
                : {})}
            />
          </div>
        ))}

        {voiceCaption?.text.trim() ? (
          <div
            aria-label="Live voice caption"
            className="mx-auto w-full max-w-2xl rounded-xl border border-[var(--chat-header-border)] bg-[var(--chat-header-bg)] px-4 py-3 text-[var(--chat-text)]"
            dir="auto"
            role="group"
            tabIndex={0}
          >
            <p className="mb-1 text-xs font-semibold text-[var(--chat-text-muted)]">
              {voiceCaption.interrupted
                ? 'Guide · Interrupted; finalizing'
                : 'Guide · Caption in progress'}
            </p>
            <p
              aria-label="Caption text"
              className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--chat-accent)]"
              tabIndex={0}
            >
              {voiceCaption.text}
            </p>
          </div>
        ) : null}

        {onRequestMore &&
        !isLoading &&
        messages.at(-1)?.role === 'assistant' &&
        !messages.at(-1)?.voiceDelivery &&
        messages.at(-1)?.replyKind !== 'TEMPORARY_FALLBACK' ? (
          <div className="flex justify-start">
            <button
              type="button"
              onClick={onRequestMore}
              disabled={isLoading || !isOnline || conversationLocked || sendDisabled}
              className={styles.requestMore}
            >
              {requestMoreLabel}
            </button>
          </div>
        ) : null}

        {isLoading && messages.at(-1)?.role !== 'assistant' ? (
          <TypingIndicator
            statusLabel={
              presentation.code === 'en' ? (
                <span lang="en" dir="ltr">
                  Thinking…
                </span>
              ) : (
                <span lang={presentation.code} dir={presentation.direction}>
                  {assistantLabel} {respondingLabel}…
                </span>
              )
            }
            {...(presentation.code === 'en'
              ? {
                  longWaitLabel: (
                    <span lang="en" dir="ltr">
                      Still working on it.
                    </span>
                  ),
                }
              : {})}
          />
        ) : null}

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

      <div
        key={voiceCaptionAnnouncementKey}
        className="sr-only"
        aria-label="Voice caption updates"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {voiceCaptionAnnouncement}
      </div>

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveAnnouncement?.kind === 'responding' ? (
          presentation.code === 'en' ? (
            <span lang="en" dir="ltr">
              Guide is answering
            </span>
          ) : (
            <span lang={presentation.code} dir={presentation.direction}>
              {assistantLabel} {respondingLabel}
            </span>
          )
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
          <div className={styles.composerInput}>
            {draft.length === 0 ? (
              <span className={styles.composerHint} aria-hidden="true" dir="auto">
                {placeholder}
              </span>
            ) : null}
            <textarea
              ref={composerRef}
              id={composerId}
              lang=""
              dir="auto"
              className="min-h-14 flex-1 resize-none rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-4 py-3 text-[16px] leading-6 text-[var(--chat-text)] outline-none transition placeholder:text-[var(--chat-text-muted)] focus:border-[var(--chat-accent)] focus:ring-2 focus:ring-[var(--chat-accent)]/20"
              enterKeyHint="send"
              aria-placeholder={placeholder}
              rows={1}
              value={draft}
              onChange={(event) => {
                const nextDraft = event.target.value
                setDraft(nextDraft)
                rememberDraft(nextDraft)
                onDraftChange?.(nextDraft)
              }}
              onKeyDown={(event) => {
                // Safari reports the Enter that confirms an IME conversion as keyCode 229 with
                // isComposing already false; that Enter belongs to the IME, not to sending.
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </div>
          {composerVoiceControl}
          <button
            ref={sendButtonRef}
            style={{
              backgroundColor:
                isOnline &&
                !isLoading &&
                !conversationLocked &&
                !sendDisabled &&
                draft.trim().length > 0
                  ? accentColor
                  : undefined,
              color:
                isOnline &&
                !isLoading &&
                !conversationLocked &&
                !sendDisabled &&
                draft.trim().length > 0
                  ? accentContrastColor
                  : undefined,
            }}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-transparent bg-[var(--chat-accent)] px-5 text-sm font-semibold text-[var(--chat-accent-contrast)] transition disabled:cursor-not-allowed disabled:border-[var(--chat-border)] disabled:bg-[var(--chat-card)] disabled:text-[var(--chat-text-muted)] ${isLoading && onStopResponse ? styles.stopButton : ''}`}
            disabled={
              !isOnline ||
              conversationLocked ||
              sendDisabled ||
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
            onTouchStart={(event) => {
              const touch = event.changedTouches[0]
              sendTouchStartRef.current =
                event.touches.length === 1 && touch
                  ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
                  : null
            }}
            onTouchCancel={() => {
              if (sendTouchStartRef.current) lastSendTouchEndAtRef.current = Date.now()
              sendTouchStartRef.current = null
            }}
            onTouchEnd={(event) => {
              const start = sendTouchStartRef.current
              const touch = Array.from(event.changedTouches).find(
                (candidate) => candidate.identifier === start?.id,
              )
              sendTouchStartRef.current = null
              if (!start || !touch) return
              // Even a swipe can produce a delayed compatibility click in some
              // engines; do not let that turn a cancelled gesture into a send.
              lastSendTouchEndAtRef.current = Date.now()
              if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 12) {
                return
              }
              // On Safari, dismissing the keyboard can move Send between touch
              // release and the synthetic click. Act on release, then suppress
              // that click so a single tap cannot submit twice.
              event.preventDefault()
              if (isLoading) onStopResponse?.()
              else submit()
            }}
            onClick={(event) => {
              if (event.detail > 0 && Date.now() - lastSendTouchEndAtRef.current < 750) return
              if (isLoading) onStopResponse?.()
              else submit()
            }}
          >
            {isLoading && onStopResponse ? (
              <>
                <span className="text-base leading-none" aria-hidden="true">
                  ■
                </span>
                <span className="ml-2" aria-hidden="true">
                  {stopResponseLabel}
                </span>
              </>
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
