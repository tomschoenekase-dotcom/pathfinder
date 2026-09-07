import { describe, expect, it, vi } from 'vitest'
import { readApprovedGuestPlaceMedia } from './guest-place-media'
import type { GuestPlaceMediaReader } from './guest-place-media'

const readerWith = (findMany: ReturnType<typeof vi.fn>) =>
  ({ venueMediaDerivative: { findMany } }) as unknown as GuestPlaceMediaReader

const approved = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  approvedReviewSequence: 2,
  createdAt: new Date('2026-09-07T12:00:00Z'),
  asset: {
    altText: 'East gallery',
    caption: 'Gallery entrance',
    sourceName: 'Museum archive',
    sourceUrl: 'https://museum.example/photo',
    placeLinks: [{ placeId: 'place-1' }],
    reviews: [{ sequence: 2, action: 'APPROVE_CONTENT_USE', rightsBasis: 'OWNED' }],
  },
  ...overrides,
})

describe('readApprovedGuestPlaceMedia', () => {
  it('does no read while photos are disabled', async () => {
    const findMany = vi.fn()
    expect(
      await readApprovedGuestPlaceMedia({
        reader: readerWith(findMany),
        tenantId: 't',
        venueId: 'v',
        venueSlug: 'museum',
        placeIds: ['place-1'],
        showPhotos: false,
        showLinks: false,
      }),
    ).toEqual(new Map())
    expect(findMany).not.toHaveBeenCalled()
  })
  it('projects only a currently approved CARD and retains text credit when links are disabled', async () => {
    const findMany = vi.fn().mockResolvedValue([approved()])
    const result = await readApprovedGuestPlaceMedia({
      reader: readerWith(findMany),
      tenantId: 't',
      venueId: 'v',
      venueSlug: 'museum',
      placeIds: ['place-1'],
      showPhotos: true,
      showLinks: false,
    })
    expect(result.get('place-1')).toEqual({
      photoUrl: '/api/venue-media/11111111-1111-4111-8111-111111111111?venue=museum',
      photoAttribution: {
        altText: 'East gallery',
        caption: 'Gallery entrance',
        sourceName: 'Museum archive',
        sourceUrl: null,
      },
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't',
          venueId: 'v',
          variant: 'CARD',
          status: 'READY',
        }),
        take: 100,
      }),
    )
  })
  it('fails closed after a later revocation and strips unsafe attribution links', async () => {
    const revoked = approved({
      asset: {
        ...approved().asset,
        reviews: [{ sequence: 3, action: 'REVOKE_CONTENT_USE', rightsBasis: null }],
      },
    })
    const reader = readerWith(vi.fn().mockResolvedValue([revoked]))
    expect(
      (
        await readApprovedGuestPlaceMedia({
          reader,
          tenantId: 't',
          venueId: 'v',
          venueSlug: 'museum',
          placeIds: ['place-1'],
          showPhotos: true,
          showLinks: true,
        })
      ).size,
    ).toBe(0)
  })

  it('keeps supplementary-character credits within the response contract without broken surrogates', async () => {
    const credit = '\u{1F30D}'.repeat(400)
    const result = await readApprovedGuestPlaceMedia({
      reader: readerWith(
        vi.fn().mockResolvedValue([
          approved({
            asset: {
              ...approved().asset,
              altText: credit,
              sourceName: credit,
              caption: credit.repeat(2),
            },
          }),
        ]),
      ),
      tenantId: 't',
      venueId: 'v',
      venueSlug: 'museum',
      placeIds: ['place-1'],
      showPhotos: true,
      showLinks: false,
    })
    const attribution = result.get('place-1')!.photoAttribution
    expect(attribution.altText.length).toBe(500)
    expect(attribution.sourceName.length).toBe(500)
    expect(attribution.caption!.length).toBe(1000)
    expect(attribution.altText.endsWith('\u{1F30D}')).toBe(true)
  })

  it.each([
    'https://museum.example/photo#token=secret',
    `https://museum.example/${'\u754c'.repeat(250)}`,
    `https://museum.example/${'x'.repeat(2_001)}`,
  ])('drops an unsafe source link while preserving its text credit: %s', async (sourceUrl) => {
    const row = approved({ asset: { ...approved().asset, sourceUrl } })
    const result = await readApprovedGuestPlaceMedia({
      reader: readerWith(vi.fn().mockResolvedValue([row])),
      tenantId: 't',
      venueId: 'v',
      venueSlug: 'museum',
      placeIds: ['place-1'],
      showPhotos: true,
      showLinks: true,
    })
    expect(result.get('place-1')?.photoAttribution).toMatchObject({
      sourceName: 'Museum archive',
      sourceUrl: null,
    })
  })
})
