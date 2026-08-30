import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  afterEach(() => cleanup())

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
