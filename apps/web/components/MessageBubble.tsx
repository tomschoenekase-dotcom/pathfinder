import styles from './visitor-chat.module.css'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type {
  GuestResponseBlock,
  GuestResponsePlace,
  GuestVisitorAction,
} from '@pathfinder/contracts/guest-response'

import { ResponseRenderer } from './ResponseRenderer'
import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

/** Which reading surface each speaker's text sits on, resolved from the venue appearance. */
export type MessageSurfaces = {
  user: 'bubble' | 'none'
  assistant: 'bubble' | 'protected' | 'none'
}

const DEFAULT_SURFACES: MessageSurfaces = { user: 'bubble', assistant: 'none' }

type MessageBubbleProps = {
  role: 'user' | 'assistant'
  content: string
  assistantLabel?: string
  /** When set, both speakers show a small visible label ("You" / this value). */
  visibleGuideLabel?: string
  surfaces?: MessageSurfaces
  blocks?: GuestResponseBlock[]
  places?: GuestResponsePlace[]
  voiceDelivery?: 'CAPTURED' | 'INTERRUPTED'
  voicePersistence?: 'PENDING' | 'SAVED' | 'UNCONFIRMED'
  onPlaceCardClick?: (placeId: string) => void
  onPlaceCardView?: (placeId: string) => void
  onDirectionsClick?: (placeId: string) => void
  onChoiceSelect?: (value: string) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  language?: SupportedChatLanguage
  locationAware?: boolean
}

export function MessageBubble({
  role,
  content,
  assistantLabel = 'Venue guide',
  visibleGuideLabel,
  surfaces = DEFAULT_SURFACES,
  blocks,
  places,
  voiceDelivery,
  voicePersistence,
  onPlaceCardClick,
  onPlaceCardView,
  onDirectionsClick,
  onChoiceSelect,
  onVisitorAction,
  language = 'English',
  locationAware = false,
}: MessageBubbleProps) {
  const isUser = role === 'user'
  const presentation = getChatLanguagePresentation(language)
  const youLabel = getVisitorUiCopy(language).shell[4]
  const voiceCopy = getVisitorUiCopy(language).voice
  const speaker = isUser ? youLabel : assistantLabel
  const visibleSpeaker = visibleGuideLabel ? (isUser ? youLabel : visibleGuideLabel) : null
  const surface = isUser ? surfaces.user : surfaces.assistant

  return (
    <article className={styles.message} data-role={role} data-surface={surface}>
      {visibleSpeaker ? (
        <p
          className={styles.speaker}
          lang={presentation.code}
          dir={presentation.direction}
          aria-hidden="true"
        >
          {visibleSpeaker}
        </p>
      ) : null}
      <div
        className={isUser ? styles.user : styles.assistant}
        {...(isUser ? {} : { 'data-surface': surface })}
      >
        {voiceDelivery ? (
          <p className="mb-1 text-xs font-semibold opacity-80">
            {voiceCopy.transcript}
            <span className="font-medium">
              {voiceDelivery === 'INTERRUPTED'
                ? ` · ${voiceCopy.interrupted}`
                : ` · ${voiceCopy.captured}`}
              {voicePersistence === 'PENDING'
                ? ` · ${voiceCopy.saving}`
                : voicePersistence === 'UNCONFIRMED'
                  ? ` · ${voiceCopy.unconfirmed}`
                  : ''}
            </span>
          </p>
        ) : null}
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
            locationAware={locationAware}
            {...(blocks ? { blocks } : {})}
            {...(places ? { places } : {})}
            {...(onPlaceCardClick ? { onPlaceCardClick } : {})}
            {...(onPlaceCardView ? { onPlaceCardView } : {})}
            {...(onDirectionsClick ? { onDirectionsClick } : {})}
            {...(onChoiceSelect ? { onChoiceSelect } : {})}
            {...(onVisitorAction ? { onVisitorAction } : {})}
          />
        )}
      </div>
    </article>
  )
}
