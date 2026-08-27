import { createHash } from 'node:crypto'

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readControlledVenueMediaDerivative,
  VenueMediaDeliveryUnavailableError,
} from './venue-media-delivery'

const derivativeFindFirst = vi.fn()
const resolveVenueScope = vi.fn()
const storageSend = vi.fn()
const db = { venueMediaDerivative: { findFirst: derivativeFindFirst } }
const bytes = Buffer.from('controlled-derivative')
const sha256 = createHash('sha256').update(bytes).digest('hex')

async function* body(value: Buffer) {
  yield value
}

describe('controlled venue media delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STORAGE_BUCKET = 'test-bucket'
    process.env.STORAGE_REGION = 'us-east-1'
    process.env.STORAGE_ACCESS_KEY_ID = 'test-access'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret'
    resolveVenueScope.mockResolvedValue({ id: 'venue_1', tenantId: 'tenant_1' })
    derivativeFindFirst.mockResolvedValue({
      approvedReviewSequence: 1,
      objectKey: 'staging/venue-media-derivatives/exact.webp',
      storageVersionId: `unversioned-sha256:${sha256}`,
      mimeType: 'image/webp',
      byteSize: bytes.byteLength,
      sha256,
      asset: {
        reviews: [{ sequence: 1, action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
      },
    })
    storageSend.mockResolvedValue({ Body: body(bytes) })
  })

  it('streams only the retained bytes and never returns the object key', async () => {
    const result = await readControlledVenueMediaDerivative({
      derivativeId: '11111111-1111-4111-8111-111111111111',
      venueSlug: 'city-zoo',
      db: db as never,
      storage: { send: storageSend } as never,
      resolveVenueScope,
    })
    expect(result.bytes).toEqual(bytes)
    expect(derivativeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
      }),
    )
    expect(storageSend.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand)
    expect((storageSend.mock.calls[0]?.[0] as GetObjectCommand).input).not.toHaveProperty(
      'VersionId',
    )
    expect(JSON.stringify(result)).not.toContain('objectKey')
  })

  it('fails closed immediately after rights withdrawal', async () => {
    derivativeFindFirst.mockResolvedValue({
      approvedReviewSequence: 1,
      objectKey: 'staging/venue-media-derivatives/exact.webp',
      storageVersionId: `unversioned-sha256:${sha256}`,
      mimeType: 'image/webp',
      byteSize: bytes.byteLength,
      sha256,
      asset: { reviews: [{ sequence: 2, action: 'WITHDRAW_CONTENT_USE', rightsBasis: null }] },
    })
    await expect(
      readControlledVenueMediaDerivative({
        derivativeId: '11111111-1111-4111-8111-111111111111',
        venueSlug: 'city-zoo',
        db: db as never,
        storage: { send: storageSend } as never,
        resolveVenueScope,
      }),
    ).rejects.toBeInstanceOf(VenueMediaDeliveryUnavailableError)
    expect(storageSend).not.toHaveBeenCalled()
  })

  it('rejects storage bytes that do not match the retained hash', async () => {
    storageSend.mockResolvedValue({ Body: body(Buffer.from('tampered-derivative')) })
    await expect(
      readControlledVenueMediaDerivative({
        derivativeId: '11111111-1111-4111-8111-111111111111',
        venueSlug: 'city-zoo',
        db: db as never,
        storage: { send: storageSend } as never,
        resolveVenueScope,
      }),
    ).rejects.toBeInstanceOf(VenueMediaDeliveryUnavailableError)
  })
})
