import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { createVenueMediaDerivative, VENUE_MEDIA_DERIVATIVE_POLICY } from './venue-media-derivative'

describe('venue media derivative transformation', () => {
  it('creates a bounded metadata-stripped WebP card without enlarging the source', async () => {
    const source = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: '#2f6f78' },
    })
      .jpeg()
      .withExif({ IFD0: { Artist: 'private source metadata' } })
      .toBuffer()
    const result = await createVenueMediaDerivative(source, 'CARD')
    const metadata = await sharp(result.bytes).metadata()

    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBe(768)
    expect(metadata.height).toBe(384)
    expect(metadata.exif).toBeUndefined()
    expect(metadata.icc).toBeUndefined()
    expect(result.bytes.byteLength).toBeLessThanOrEqual(
      VENUE_MEDIA_DERIVATIVE_POLICY.CARD.maximumBytes,
    )
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not enlarge a small detail image', async () => {
    const source = await sharp({
      create: { width: 320, height: 180, channels: 4, background: '#d7ad43' },
    })
      .png()
      .toBuffer()
    const result = await createVenueMediaDerivative(source, 'DETAIL')
    expect({ width: result.width, height: result.height }).toEqual({ width: 320, height: 180 })
  })
})
