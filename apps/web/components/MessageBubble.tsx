import type { GuestResponseBlock, GuestResponsePlace } from '@pathfinder/contracts/guest-response'

import { ResponseRenderer } from './ResponseRenderer'

type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
  bubbleColor?: string
  bubbleTextColor?: string
  blocks?: GuestResponseBlock[]
  places?: GuestResponsePlace[]
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onChoiceSelect?: (value: string) => void
}

export function MessageBubble({
  role,
  content,
  bubbleColor,
  bubbleTextColor,
  blocks,
  places,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onChoiceSelect,
}: MessageBubbleProps) {
  const isUser = role === 'user'
  const speaker = isUser ? 'You' : 'PathFinder guide'

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
        <span className="sr-only" lang="en" dir="ltr">
          {speaker}:
        </span>
        {isUser ? (
          <p className="whitespace-pre-wrap break-words" lang="" dir="auto">
            {content}
          </p>
        ) : (
          <ResponseRenderer
            content={content}
            {...(blocks ? { blocks } : {})}
            {...(places ? { places } : {})}
            {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
            {...(onPlaceCardView ? { onPlaceCardView } : {})}
            {...(onDirectionsClick ? { onDirectionsClick } : {})}
            {...(onChoiceSelect ? { onChoiceSelect } : {})}
          />
        )}
      </div>
    </article>
  )
}
