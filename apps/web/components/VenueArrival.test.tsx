import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
import { VenueArrival } from './VenueArrival'

const venue = {
  name: 'Great Lakes Discovery Museum',
  description: 'Explore lake ecology, shipping history, and hands-on family exhibits.',
  category: 'museum',
}

describe('VenueArrival', () => {
  beforeEach(() => vi.stubGlobal('React', React))
  afterEach(() => cleanup())

  it('shows saved branding and removes failed decorative images without losing entry actions', () => {
    const { container, rerender } = render(
      <VenueArrival
        venue={{ ...venue, chatLogoUrl: '/logo', chatBannerUrl: '/banner' }}
        venueSlug="great-lakes-museum"
        media={[]}
        mediaStatus="ready"
      />,
    )
    expect(container.querySelectorAll('img')).toHaveLength(2)
    for (const image of container.querySelectorAll('img')) fireEvent.error(image)
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(screen.getByRole('link', { name: /open your guide/i })).toBeTruthy()
    rerender(
      <VenueArrival
        venue={{ ...venue, chatBannerUrl: '/replacement' }}
        venueSlug="great-lakes-museum"
        media={[]}
        mediaStatus="ready"
      />,
    )
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/replacement')
  })

  it('keeps the guide complete when the venue has no approved media', () => {
    vi.stubGlobal('React', React)
    render(
      <VenueArrival venue={venue} venueSlug="great-lakes-museum" media={[]} mediaStatus="ready" />,
    )

    expect(screen.getByRole('heading', { name: venue.name })).toBeTruthy()
    expect(screen.getByRole('link', { name: /open your guide/i }).getAttribute('href')).toBe(
      '/great-lakes-museum/chat',
    )
    expect(screen.queryByText(/photos are temporarily unavailable/i)).toBeNull()
  })

  it('reports a media-only outage without disabling the guide', () => {
    render(
      <VenueArrival
        venue={venue}
        venueSlug="great-lakes-museum"
        media={[]}
        mediaStatus="unavailable"
      />,
    )

    expect(screen.getByRole('status').textContent).toContain('Your guide is ready')
    expect(screen.getByRole('link', { name: /open your guide/i })).toBeTruthy()
  })

  it('offers editable entry questions and keeps the venue theme local', () => {
    const { container } = render(
      <VenueArrival
        venue={{ ...venue, chatTheme: 'forest', chatAccentColor: '#efaa44' }}
        venueSlug="great-lakes-museum"
        media={[]}
        mediaStatus="ready"
      />,
    )
    const link = screen.getByRole('link', { name: 'What should I see first?' })
    const target = new URL(link.getAttribute('href')!, 'https://example.test')
    expect(target.pathname).toBe('/great-lakes-museum/chat')
    expect(target.searchParams.get('prompt')).toBe('What should I see first?')
    expect(container.querySelector('main')?.style.getPropertyValue('--arrival-bg')).toBe('#F0F7F4')
    expect(container.querySelector('main')?.style.getPropertyValue('--arrival-accent')).toBe(
      '#efaa44',
    )
    expect(document.documentElement.style.getPropertyValue('--arrival-accent')).toBe('')
  })

  it('does not reserve a media column for rejected locators', () => {
    const { container } = render(
      <VenueArrival
        venue={venue}
        venueSlug="great-lakes-museum"
        media={[
          {
            assetId: '11111111-1111-4111-8111-111111111111',
            derivativeId: '22222222-2222-4222-8222-222222222222',
            variant: 'CARD',
            kind: 'IMAGE',
            altText: 'Unsafe external image',
            caption: null,
            importance: 'PRIMARY',
            width: 768,
            height: 512,
            byteSize: 200_000,
            mimeType: 'image/webp',
            deliveryPath: 'https://storage.example/raw.webp',
          } as never,
        ]}
        mediaStatus="ready"
      />,
    )

    expect(screen.queryByRole('region', { name: /venue media/i })).toBeNull()
    expect(
      container.querySelector(
        '.lg\\:grid-cols-\\[minmax\\(0\\,1\\.15fr\\)_minmax\\(22rem\\,\\.85fr\\)\\]',
      ),
    ).toBeNull()
  })
})
