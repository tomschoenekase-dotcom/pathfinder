'use client'

import Link from 'next/link'
import { TorchikoIcon } from '@pathfinder/ui/brand'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import type { VenueChatPresentation } from './venue-chat-types'
import { getVisitorStateCopy, getVisitorTextPresentation } from './visitor-ui-copy'

export function VenueChatSkeleton({ language = 'English' }: { language?: SupportedChatLanguage }) {
  const presentation = getVisitorTextPresentation(language)
  const [loading] = getVisitorStateCopy(language)
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-pf-surface px-6"
      lang={presentation.code}
      dir={presentation.direction}
    >
      <div
        className="flex flex-col items-center gap-5 text-center"
        role="status"
        lang={presentation.code}
        dir={presentation.direction}
      >
        <TorchikoIcon className="h-10 w-10 animate-pulse motion-reduce:animate-none" />
        <p className="text-sm font-medium text-pf-deep/75">{loading}</p>
      </div>
    </main>
  )
}

export function VenueChatError({
  message,
  presentation,
  language = 'English',
}: {
  message: string
  presentation: VenueChatPresentation
  language?: SupportedChatLanguage
}) {
  const languagePresentation = getVisitorTextPresentation(language)
  const [, venueUnavailable, , , tryAgain, backToHome] = getVisitorStateCopy(language)
  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-pf-surface px-6"
      lang={languagePresentation.code}
      dir={languagePresentation.direction}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm"
        role="alert"
      >
        <h1 className="text-2xl font-semibold text-pf-deep">{venueUnavailable}</h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/75">{message}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
          >
            {tryAgain}
          </button>
          {presentation === 'standalone' ? (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
            >
              {backToHome}
            </Link>
          ) : null}
        </div>
      </div>
    </main>
  )
}
