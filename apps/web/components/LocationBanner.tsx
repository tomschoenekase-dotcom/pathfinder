import React from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { getChatLanguagePresentation } from './LanguagePicker'
import { getVisitorUiCopy } from './visitor-ui-copy'

type LocationBannerProps = {
  permission: 'granted' | 'denied' | 'prompt' | 'loading'
  onRefresh: () => void
  show?: boolean
  language?: SupportedChatLanguage
}

export function LocationBanner({
  permission,
  onRefresh,
  show = true,
  language = 'English',
}: LocationBannerProps) {
  const { location } = getVisitorUiCopy(language)
  const [
    checkingTitle,
    checkingDescription,
    deniedTitle,
    deniedDescription,
    deniedAction,
    promptTitle,
    promptDescription,
    promptAction,
  ] = location
  const presentation = getChatLanguagePresentation(language)
  if (show === false) {
    return null
  }

  if (permission === 'granted') {
    return null
  }

  if (permission === 'loading') {
    return (
      <section
        lang={presentation.code}
        dir={presentation.direction}
        aria-label={checkingTitle}
        role="status"
        className="mb-2 px-1 py-1 text-xs leading-5 text-[var(--chat-text-muted)]"
      >
        {checkingDescription}
      </section>
    )
  }

  const content =
    permission === 'denied'
      ? {
          title: deniedTitle,
          description: deniedDescription,
          action: deniedAction,
        }
      : {
          title: promptTitle,
          description: promptDescription,
          action: promptAction,
        }

  return (
    <section
      lang={presentation.code}
      dir={presentation.direction}
      aria-label={content.title}
      className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 py-0.5"
    >
      <p className="min-w-0 flex-1 text-xs leading-5 text-[var(--chat-text-muted)]">
        {content.description}
      </p>
      <button
        className="inline-flex min-h-11 shrink-0 items-center justify-center px-1 text-xs font-semibold text-[var(--chat-accent-text)] underline-offset-4 transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chat-accent)] focus-visible:ring-offset-2 motion-reduce:transition-none"
        type="button"
        onClick={onRefresh}
      >
        {content.action}
      </button>
    </section>
  )
}
