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
        className="mb-4 rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-4 text-[var(--chat-text-muted)] shadow-sm"
      >
        <p className="text-sm font-semibold text-[var(--chat-text)]">{checkingTitle}</p>
        <p className="mt-1 text-sm leading-6 text-[var(--chat-text-muted)]">
          {checkingDescription}
        </p>
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
      className="mb-4 rounded-3xl border border-amber-200 bg-amber-50 p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-pf-deep">{content.title}</p>
          <p className="mt-1 text-sm leading-6 text-pf-deep/70">{content.description}</p>
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-amber-300 bg-pf-white px-4 text-sm font-medium text-amber-700 transition hover:bg-amber-50"
          type="button"
          onClick={onRefresh}
        >
          {content.action}
        </button>
      </div>
    </section>
  )
}
