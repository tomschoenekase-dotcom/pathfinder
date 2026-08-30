'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import { TorchikoIcon } from '@pathfinder/ui/brand'
import { getStoredLanguage, SUPPORTED_LANGUAGES } from './LanguagePicker'
import { VenueRetryButton } from './VenueRetryButton'
import { getVisitorStateCopy, getVisitorTextPresentation } from './visitor-ui-copy'

export function VenueTemporarilyUnavailable({
  showHomeLink = true,
  language,
}: {
  showHomeLink?: boolean
  language?: SupportedChatLanguage
}) {
  const [resolvedLanguage, setResolvedLanguage] = useState<SupportedChatLanguage>(
    language ?? 'English',
  )

  useEffect(() => {
    if (language) {
      setResolvedLanguage(language)
      return
    }
    const stored = getStoredLanguage()
    if (SUPPORTED_LANGUAGES.some((entry) => entry.label === stored)) {
      setResolvedLanguage(stored as SupportedChatLanguage)
    }
  }, [language])

  const presentation = getVisitorTextPresentation(resolvedLanguage)
  const [, , unavailableTitle, unavailableBody, tryAgain, backToHome] =
    getVisitorStateCopy(resolvedLanguage)

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-pf-surface px-6"
      lang={presentation.code}
      dir={presentation.direction}
    >
      <section className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-10 text-center shadow-sm">
        <TorchikoIcon className="mx-auto h-12 w-12" />
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-pf-deep">
          {unavailableTitle}
        </h1>
        <p className="mt-3 text-sm leading-6 text-pf-deep/60">{unavailableBody}</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <VenueRetryButton label={tryAgain} />
          {showHomeLink ? (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
            >
              {backToHome}
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  )
}
