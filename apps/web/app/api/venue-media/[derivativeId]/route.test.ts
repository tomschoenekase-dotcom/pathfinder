import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readControlled } = vi.hoisted(() => ({ readControlled: vi.fn() }))

vi.mock('@pathfinder/api/venue-media-delivery', () => ({
  readControlledVenueMediaDerivative: readControlled,
}))

import { GET } from './route'

const derivativeId = '11111111-1111-4111-8111-111111111111'

describe('venue media delivery route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readControlled.mockResolvedValue({
      bytes: Buffer.from('webp-bytes'),
      mimeType: 'image/webp',
      sha256: 'a'.repeat(64),
    })
  })

  it('returns same-origin no-store image bytes with hardening headers', async () => {
    const response = await GET(
      new Request(`https://guide.example/api/venue-media/${derivativeId}?venue=city-zoo`),
      { params: Promise.resolve({ derivativeId }) },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/webp')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(readControlled).toHaveBeenCalledWith({ derivativeId, venueSlug: 'city-zoo' })
  })

  it('returns the same opaque 404 for invalid identity and withdrawn media', async () => {
    const invalid = await GET(
      new Request('https://guide.example/api/venue-media/not-a-uuid?venue=city-zoo'),
      { params: Promise.resolve({ derivativeId: 'not-a-uuid' }) },
    )
    expect(invalid.status).toBe(404)
    expect(readControlled).not.toHaveBeenCalled()

    readControlled.mockRejectedValue(new Error('withdrawn'))
    const withdrawn = await GET(
      new Request(`https://guide.example/api/venue-media/${derivativeId}?venue=city-zoo`),
      { params: Promise.resolve({ derivativeId }) },
    )
    expect(withdrawn.status).toBe(404)
    expect(await withdrawn.text()).toBe('Not found')
  })
})
