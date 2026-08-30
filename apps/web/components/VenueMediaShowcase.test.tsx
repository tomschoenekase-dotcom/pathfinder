import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import { VenueMediaShowcase } from './VenueMediaShowcase'

const media: PublicVenueMediaItem[] = [
  {
    assetId: '11111111-1111-4111-8111-111111111111',
    derivativeId: '22222222-2222-4222-8222-222222222222',
    variant: 'CARD',
    kind: 'IMAGE',
    altText: 'A restored streetcar beside the museum platform',
    caption: 'The restored 1949 streetcar in the main gallery.',
    importance: 'PRIMARY',
    width: 768,
    height: 512,
    byteSize: 240_000,
    mimeType: 'image/webp',
    deliveryPath: '/api/venue-media/22222222-2222-4222-8222-222222222222?venue=city-museum',
  },
]

describe('VenueMediaShowcase', () => {
  afterEach(() => cleanup())

  it('presents controlled media with intrinsic dimensions, alt text, and caption', () => {
    vi.stubGlobal('React', React)
    render(<VenueMediaShowcase venueName="City Museum" items={media} />)

    const image = screen.getByRole('img', { name: media[0]!.altText }) as HTMLImageElement
    expect(image.src).toContain('/api/venue-media/')
    expect(image.getAttribute('width')).toBe('768')
    expect(image.getAttribute('height')).toBe('512')
    expect(screen.getByText(media[0]!.caption!)).toBeTruthy()
    expect(screen.getByText('Media approved for this venue.')).toBeTruthy()
  })

  it('renders no awkward placeholder when approved media is absent', () => {
    const { container } = render(<VenueMediaShowcase venueName="City Museum" items={[]} />)

    expect(container.innerHTML).toBe('')
    expect(screen.queryByRole('img')).toBeNull()
  })
})
