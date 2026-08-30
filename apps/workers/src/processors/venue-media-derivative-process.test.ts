import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  derivativeFindFirst: vi.fn(),
  derivativeUpdateMany: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venueMediaDerivative: {
      findFirst: mocks.derivativeFindFirst,
      updateMany: mocks.derivativeUpdateMany,
    },
    $transaction: mocks.transaction,
  },
  withTenantIsolationBypass: (operation: () => unknown) => operation(),
  writeAuditLogStrict: mocks.audit,
}))

import { processVenueMediaDerivativeJob } from './venue-media-derivative'

const payload = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  derivativeId: '11111111-1111-4111-8111-111111111111',
}

describe('venue media derivative processor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RAILWAY_ENVIRONMENT = 'staging'
    process.env.STORAGE_BUCKET = 'test-bucket'
    process.env.STORAGE_REGION = 'us-east-1'
    process.env.STORAGE_ACCESS_KEY_ID = 'test-access'
    process.env.STORAGE_SECRET_ACCESS_KEY = 'test-secret'
    mocks.derivativeUpdateMany.mockResolvedValue({ count: 1 })
  })

  it('fails closed before reading storage when the approval was withdrawn', async () => {
    mocks.derivativeFindFirst.mockResolvedValue({
      id: payload.derivativeId,
      variant: 'CARD',
      status: 'PENDING',
      sourceObjectGeneration: '22222222-2222-4222-8222-222222222222',
      sourceStorageVersionId: 'source-version-1',
      approvedReviewSequence: 1,
      asset: {
        intakeUpload: {
          objectKey: 'staging/intake-quarantine/source',
          objectGeneration: '22222222-2222-4222-8222-222222222222',
          storageVersionId: 'source-version-1',
          byteSize: 100,
          status: 'AWAITING_REVIEW',
          verifiedAt: new Date(),
        },
        reviews: [{ sequence: 2, action: 'WITHDRAW_CONTENT_USE', rightsBasis: null }],
      },
    })
    const storage = { send: vi.fn() }
    await expect(processVenueMediaDerivativeJob(payload, { storage })).resolves.toMatchObject({
      state: 'failed-closed',
    })
    expect(mocks.derivativeUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: 'RIGHTS_NOT_CURRENT' }),
      }),
    )
    expect(storage.send).not.toHaveBeenCalled()
  })

  it('writes a stripped derivative and rechecks rights in the final transaction', async () => {
    const source = await sharp({
      create: { width: 900, height: 450, channels: 3, background: '#2f6f78' },
    })
      .png()
      .toBuffer()
    mocks.derivativeFindFirst.mockResolvedValue({
      id: payload.derivativeId,
      variant: 'CARD',
      status: 'PENDING',
      sourceObjectGeneration: '22222222-2222-4222-8222-222222222222',
      sourceStorageVersionId: 'source-version-1',
      approvedReviewSequence: 1,
      asset: {
        intakeUpload: {
          objectKey: 'staging/intake-quarantine/source',
          objectGeneration: '22222222-2222-4222-8222-222222222222',
          storageVersionId: 'source-version-1',
          byteSize: source.byteLength,
          status: 'AWAITING_REVIEW',
          verifiedAt: new Date(),
        },
        reviews: [{ sequence: 1, action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
      },
    })
    const storage = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Body: (async function* () {
            yield source
          })(),
        })
        .mockResolvedValueOnce({ VersionId: 'derivative-version-1' }),
    }
    const tx = {
      venueMediaDerivative: {
        findFirst: vi.fn().mockResolvedValue({
          approvedReviewSequence: 1,
          asset: {
            reviews: [{ sequence: 1, action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
          },
        }),
        update: vi.fn().mockResolvedValue({ id: payload.derivativeId }),
      },
    }
    mocks.transaction.mockImplementation((operation: (value: typeof tx) => unknown) =>
      operation(tx),
    )
    mocks.audit.mockResolvedValue(undefined)

    await expect(processVenueMediaDerivativeJob(payload, { storage })).resolves.toMatchObject({
      state: 'ready',
    })
    expect(storage.send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand)
    expect(storage.send.mock.calls[1]?.[0]).toBeInstanceOf(PutObjectCommand)
    expect((storage.send.mock.calls[1]?.[0] as PutObjectCommand).input).toMatchObject({
      ContentType: 'image/webp',
      CacheControl: 'private, max-age=0, no-store',
    })
    expect(tx.venueMediaDerivative.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'READY', mimeType: 'image/webp' }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue_media.derivative_ready' }),
      tx,
    )
  })
})
