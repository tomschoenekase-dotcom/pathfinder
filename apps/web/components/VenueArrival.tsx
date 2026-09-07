import Link from 'next/link'
import type { CSSProperties } from 'react'
import { CHAT_FONT_OPTIONS, getChatPalette } from '@pathfinder/ui/theme'
import styles from './venue-arrival.module.css'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import { selectVenueMediaForPresentation } from '../lib/venue-media-presentation'
import { VenueMediaShowcase } from './VenueMediaShowcase'

export type VenueArrivalSummary = {
  name: string
  description: string | null
  category: string | null
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatFont?: string | null
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
}

export function VenueArrival({
  venue,
  venueSlug,
  media,
  mediaStatus,
}: {
  venue: VenueArrivalSummary
  venueSlug: string
  media: PublicVenueMediaItem[]
  mediaStatus: 'ready' | 'unavailable'
}) {
  const presentedMedia = selectVenueMediaForPresentation(media)
  const hasMedia = presentedMedia.length > 0

  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const font =
    CHAT_FONT_OPTIONS.find((item) => item.value === venue.chatFont) ?? CHAT_FONT_OPTIONS[0]!
  const theme = {
    '--arrival-bg': palette.bg,
    '--arrival-text': palette.text,
    '--arrival-muted': palette.textMuted,
    '--arrival-border': palette.border,
    '--arrival-accent': palette.accent,
    '--arrival-contrast': palette.accentContrast,
    fontFamily: `var(${font.cssVar})`,
  } as CSSProperties

  return (
    <main className={styles.page} style={theme}>
      <div className={styles.layout}>
        <header className={styles.identity}>
          <span className={styles.category}>{venue.category || 'Welcome'}</span>
          {venue.chatLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={venue.chatLogoUrl} alt="" className={styles.wordmark} />
          ) : null}
        </header>
        <div className={hasMedia ? styles.withMedia : undefined}>
          <section className={styles.intro}>
            <p className={styles.eyebrow}>Your AI visitor guide</p>
            <h1 className={styles.title}>{venue.name}</h1>
            <p className={styles.description}>
              {venue.description ?? 'Ask your guide where to go, what to see, and what to do next.'}
            </p>
            <Link href={`/${venueSlug}/chat`} className={styles.action}>
              <span>Open your guide</span>
              <span className={styles.arrow} aria-hidden="true">
                ↗
              </span>
            </Link>
            <nav className={styles.entryQuestions} aria-label="Start with a question">
              <p>Or, start with a question</p>
              {[
                'What should I see first?',
                'Help me plan my visit.',
                'What makes this place special?',
              ].map((prompt) => (
                <Link key={prompt} href={`/${venueSlug}/chat?prompt=${encodeURIComponent(prompt)}`}>
                  <span>{prompt}</span>
                  <span aria-hidden="true">↗</span>
                </Link>
              ))}
            </nav>
            {mediaStatus === 'unavailable' ? (
              <p className={styles.notice} role="status">
                Venue photos are temporarily unavailable. Your guide is ready.
              </p>
            ) : null}
          </section>
          {hasMedia ? (
            <div className={styles.media}>
              <VenueMediaShowcase venueName={venue.name} items={presentedMedia} compact />
            </div>
          ) : null}
        </div>
        <footer className={styles.footer}>
          <span>No app to install.</span>
          <span>
            Powered by <Link href="/">Torchiko</Link>
          </span>
        </footer>
      </div>
    </main>
  )
}
