import { useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type {
  GuestResponseBlock,
  GuestResponsePlace,
  GuestVisitorAction,
} from '@pathfinder/contracts/guest-response'

import { ResponseRenderer } from './ResponseRenderer'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
  assistantLabel?: string
  bubbleColor?: string
  bubbleTextColor?: string
  blocks?: GuestResponseBlock[]
  places?: GuestResponsePlace[]
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onChoiceSelect?: (value: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  messageId?: string
  onFeedback?: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => Promise<void>
  language?: SupportedChatLanguage
}

export function MessageBubble({
  role,
  content,
  assistantLabel = 'Venue guide',
  bubbleColor,
  bubbleTextColor,
  blocks,
  places,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onChoiceSelect,
  onVisitorAction,
  messageId,
  onFeedback,
  language = 'English',
}: MessageBubbleProps) {
  const isUser = role === 'user'
  const presentation = getChatLanguagePresentation(language)
  const [
    ,
    ,
    ,
    ,
    youLabel,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    rateAnswerLabel,
    helpfulQuestion,
    helpfulLabel,
    notHelpfulLabel,
  ] = getVisitorUiCopy(language).shell
  const speaker = isUser ? youLabel : assistantLabel
  const [feedback, setFeedback] = useState<'HELPFUL' | 'NOT_HELPFUL' | null>(null)
  const [feedbackPending, setFeedbackPending] = useState(false)

  async function submitFeedback(rating: 'HELPFUL' | 'NOT_HELPFUL') {
    if (!messageId || !onFeedback || feedbackPending) return
    setFeedbackPending(true)
    try {
      await onFeedback(messageId, rating)
      setFeedback(rating)
    } finally {
      setFeedbackPending(false)
    }
  }

  return (
    <article className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`${isUser ? 'max-w-[85%]' : 'w-full max-w-[92%]'} rounded-[1.75rem] px-4 py-3 text-sm leading-6 ${
          isUser
            ? 'rounded-br-md bg-[var(--chat-accent)] text-[var(--chat-accent-contrast)]'
            : 'rounded-bl-md border border-[var(--chat-border)] bg-[var(--chat-bg)] text-[var(--chat-text)]'
        }`}
        style={{
          backgroundColor: isUser ? bubbleColor : undefined,
          color: isUser ? bubbleTextColor : undefined,
        }}
      >
        <span
          className="sr-only"
          lang={isUser ? presentation.code : undefined}
          dir={isUser ? presentation.direction : 'auto'}
        >
          {speaker}:
        </span>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words" lang="" dir="auto">
            {content}
          </p>
        ) : (
          <ResponseRenderer
            content={content}
            language={language}
            {...(blocks ? { blocks } : {})}
            {...(places ? { places } : {})}
            {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
            {...(onPlaceCardView ? { onPlaceCardView } : {})}
            {...(onDirectionsClick ? { onDirectionsClick } : {})}
            {...(onChoiceSelect ? { onChoiceSelect } : {})}
            {...(onVisitorAction ? { onVisitorAction } : {})}
          />
        )}
        {!isUser && messageId && onFeedback ? (
          <div
            className="mt-2 flex items-center gap-1 border-t border-[var(--chat-border)] pt-2"
            aria-label={rateAnswerLabel}
            lang={presentation.code}
            dir={presentation.direction}
          >
            <span className="mr-1 text-xs text-[var(--chat-text-muted)]">{helpfulQuestion}</span>
            {(
              [
                ['HELPFUL', ThumbsUp, helpfulLabel],
                ['NOT_HELPFUL', ThumbsDown, notHelpfulLabel],
              ] as const
            ).map(([rating, Icon, label]) => (
              <button
                key={rating}
                type="button"
                aria-label={label}
                aria-pressed={feedback === rating}
                disabled={feedbackPending}
                onClick={() => void submitFeedback(rating)}
                className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full text-[var(--chat-text-muted)] hover:bg-[var(--chat-card)] hover:text-[var(--chat-text)] disabled:opacity-50 aria-pressed:bg-[var(--chat-accent)] aria-pressed:text-[var(--chat-accent-contrast)]"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  )
}
