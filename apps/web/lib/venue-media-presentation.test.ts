import { describe, expect, it } from 'vitest'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'

import {
  selectVenueMediaForPresentation,
  VISITOR_MEDIA_MAX_DECLARED_BYTES,
  VISITOR_MEDIA_MAX_ITEMS,
} from './venue-media-presentation'

function item(index: number, byteSize = 300_000): PublicVenueMediaItem {
  const suffix = String(index).padStart(12, '0')
  return {
    assetId: `11111111-1111-4111-8111-${suffix}`,
    derivativeId: `22222222-2222-4222-8222-${suffix}`,
    variant: 'CARD',
    kind: 'IMAGE',
    altText: `Venue view ${index}`,
    caption: null,
    importance: index === 1 ? 'PRIMARY' : 'SECONDARY',
    width: 768,
    height: 512,
    byteSize,
    mimeType: 'image/webp',
    deliveryPath: `/api/venue-media/22222222-2222-4222-8222-${suffix}?venue=city-museum`,
  }
}

describe('venue media presentation budget', () => {
  it('admits at most three unique controlled derivatives inside the declared-byte budget', () => {
    const selected = selectVenueMediaForPresentation([item(1), item(2), item(3), item(4)])

    expect(selected).toHaveLength(VISITOR_MEDIA_MAX_ITEMS)
    expect(selected.reduce((total, entry) => total + entry.byteSize, 0)).toBeLessThanOrEqual(
      VISITOR_MEDIA_MAX_DECLARED_BYTES,
    )
  })

  it('rejects raw, external, duplicate, and over-budget media without creating a fallback request', () => {
    const first = item(1, 700_000)
    const duplicate = { ...item(2), assetId: first.assetId }
    const external = { ...item(3), deliveryPath: 'https://storage.example/raw.webp' }
    const overBudget = item(4, 600_000)

    expect(selectVenueMediaForPresentation([first, duplicate, external, overBudget])).toEqual([
      first,
    ])
  })
})
