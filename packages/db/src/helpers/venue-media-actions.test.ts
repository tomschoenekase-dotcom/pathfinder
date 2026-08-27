import { beforeEach, describe, expect, it, vi } from 'vitest'

const { audit } = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('./audit', () => ({ writeAuditLogStrict: audit }))

import {
  registerVenueMediaAssetAction,
  requestVenueMediaDerivativesAction,
  resolveApprovedVenueMediaCandidates,
  reviewVenueMediaAssetAction,
} from './venue-media-actions'

const tx = {
  venue: { findFirst: vi.fn() },
  intakeUpload: { findFirst: vi.fn() },
  place: { findMany: vi.fn() },
  venueKnowledgeEntry: { findMany: vi.fn() },
  venueMediaAsset: { create: vi.fn(), findFirst: vi.fn() },
  venueMediaReview: { findFirst: vi.fn(), create: vi.fn() },
  venueMediaDerivative: { findMany: vi.fn(), createMany: vi.fn() },
}
const venueMediaAsset = { findFirst: vi.fn(), findMany: vi.fn() }
const venueMediaDerivative = { findMany: vi.fn() }
const client = {
  $transaction: vi.fn((callback: (value: typeof tx) => unknown) => callback(tx)),
  venueMediaAsset,
  venueMediaDerivative,
}
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const registration = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  assetId: 'b66e2eef-b7d2-4ad0-8ee1-a892c8198f99',
  intakeUploadId: 'upload-1',
  kind: 'IMAGE' as const,
  semanticDescription: 'A wide view of the east gallery entrance.',
  depictedSubjects: ['east gallery'],
  altText: 'East gallery entrance beside a blue orientation sign',
  caption: null,
  usageGuidance: 'Useful when visitors ask how to recognize the east gallery entrance.',
  importance: 'SECONDARY' as const,
  sourceName: 'Venue operations photo archive',
  sourceUrl: null,
  sourceCapturedAt: null,
  linkedPlaceIds: ['place-1'],
  linkedKnowledgeEntryIds: ['knowledge-1'],
}
const verifiedUpload = {
  id: 'upload-1',
  status: 'AWAITING_REVIEW',
  category: 'PHOTO',
  mimeType: 'image/png',
  verifiedAt: new Date('2026-08-26T20:00:00.000Z'),
  objectGeneration: '544b8a1c-1f75-43f4-944d-32b2f61c82d7',
  storageVersionId: 'source-version-1',
  verificationReceipts: [
    {
      kind: 'PRECHECK',
      verdict: 'PASSED',
      objectGeneration: '544b8a1c-1f75-43f4-944d-32b2f61c82d7',
    },
    {
      kind: 'MALWARE',
      verdict: 'CLEAN',
      objectGeneration: '544b8a1c-1f75-43f4-944d-32b2f61c82d7',
    },
  ],
}

describe('governed venue media actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tx.venue.findFirst.mockResolvedValue({ id: 'venue-1' })
    tx.intakeUpload.findFirst.mockResolvedValue(verifiedUpload)
    tx.place.findMany.mockResolvedValue([{ id: 'place-1' }])
    tx.venueKnowledgeEntry.findMany.mockResolvedValue([{ id: 'knowledge-1' }])
    tx.venueMediaAsset.create.mockResolvedValue({ id: registration.assetId })
    tx.venueMediaReview.findFirst.mockResolvedValue(null)
    tx.venueMediaReview.create.mockResolvedValue({
      id: '031717d2-0395-4b16-a94c-a54d1977f7dc',
      sequence: 1,
    })
    tx.venueMediaDerivative.findMany.mockResolvedValue([])
    tx.venueMediaDerivative.createMany.mockResolvedValue({ count: 2 })
    venueMediaDerivative.findMany.mockResolvedValue([])
    audit.mockResolvedValue(undefined)
  })

  it('registers only verified controlled-storage input and exposes no delivery', async () => {
    const result = await registerVenueMediaAssetAction({
      db: client as never,
      registration,
      actor,
    })

    expect(tx.venueMediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: registration.assetId,
          intakeUploadId: 'upload-1',
          sourceUrl: null,
          createdBy: 'admin-1',
          placeLinks: {
            create: [{ tenantId: 'tenant-1', venueId: 'venue-1', placeId: 'place-1' }],
          },
        }),
      }),
    )
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'venue_media.registered',
        afterState: expect.objectContaining({ visitorDelivery: 'NOT_AVAILABLE' }),
      }),
      tx,
    )
    expect(result).toEqual({
      assetId: registration.assetId,
      reviewState: 'UNREVIEWED',
      delivery: 'NOT_AVAILABLE',
    })
  })

  it('rejects registration when malware evidence is absent for the exact object generation', async () => {
    tx.intakeUpload.findFirst.mockResolvedValue({
      ...verifiedUpload,
      verificationReceipts: verifiedUpload.verificationReceipts.slice(0, 1),
    })
    await expect(
      registerVenueMediaAssetAction({ db: client as never, registration, actor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venueMediaAsset.create).not.toHaveBeenCalled()
  })

  it('rejects any cross-scope linked entity before creating the asset', async () => {
    tx.place.findMany.mockResolvedValue([])
    await expect(
      registerVenueMediaAssetAction({ db: client as never, registration, actor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(tx.venueMediaAsset.create).not.toHaveBeenCalled()
  })

  it('appends exact rights approval without publishing or minting a visitor URL', async () => {
    tx.venueMediaAsset.findFirst.mockResolvedValue({ id: registration.assetId, reviews: [] })
    const result = await reviewVenueMediaAssetAction({
      db: client as never,
      actor,
      review: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        assetId: registration.assetId,
        requestId: '6b29cc84-a6ef-40e3-83af-110515415691',
        expectedLatestSequence: 0,
        action: 'APPROVE_CONTENT_USE',
        rightsBasis: 'VENUE_OWNED',
        rightsStatement: 'The venue created and owns this photograph.',
        rightsEvidenceSourceId: 'venue-media-release-2026-08-26',
      },
    })
    expect(tx.venueMediaReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sequence: 1,
          action: 'APPROVE_CONTENT_USE',
          rightsBasis: 'VENUE_OWNED',
          reason: null,
        }),
      }),
    )
    expect(result).toMatchObject({
      action: 'APPROVE_CONTENT_USE',
      replayed: false,
      delivery: 'CONTROLLED_DERIVATIVE_REQUIRED',
    })
  })

  it('rejects a reused review request key when the rights evidence changes', async () => {
    tx.venueMediaReview.findFirst.mockResolvedValue({
      id: '031717d2-0395-4b16-a94c-a54d1977f7dc',
      venueId: 'venue-1',
      assetId: registration.assetId,
      sequence: 1,
      action: 'APPROVE_CONTENT_USE',
      actorId: 'admin-1',
      rightsBasis: 'VENUE_OWNED',
      rightsStatement: 'The venue created and owns this photograph.',
      rightsEvidenceSourceId: 'venue-media-release-2026-08-26',
      reason: null,
    })
    await expect(
      reviewVenueMediaAssetAction({
        db: client as never,
        actor,
        review: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          assetId: registration.assetId,
          requestId: '6b29cc84-a6ef-40e3-83af-110515415691',
          expectedLatestSequence: 0,
          action: 'APPROVE_CONTENT_USE',
          rightsBasis: 'VENUE_OWNED',
          rightsStatement: 'A different rights claim must not replay.',
          rightsEvidenceSourceId: 'venue-media-release-2026-08-26',
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.venueMediaReview.create).not.toHaveBeenCalled()
  })

  it('refuses withdrawal unless the current exact review state is approved', async () => {
    tx.venueMediaAsset.findFirst.mockResolvedValue({
      id: registration.assetId,
      reviews: [{ sequence: 1, action: 'WITHDRAW_CONTENT_USE' }],
    })
    await expect(
      reviewVenueMediaAssetAction({
        db: client as never,
        actor,
        review: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          assetId: registration.assetId,
          requestId: 'eaab44ee-ad06-4f51-b5f0-7841b9e617f0',
          expectedLatestSequence: 1,
          action: 'WITHDRAW_CONTENT_USE',
          reason: 'The venue revoked permission.',
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('resolves only exact-generation approved candidates and returns no storage locator', async () => {
    venueMediaAsset.findMany.mockResolvedValue([
      {
        id: registration.assetId,
        kind: 'IMAGE',
        semanticDescription: registration.semanticDescription,
        depictedSubjects: registration.depictedSubjects,
        altText: registration.altText,
        caption: null,
        usageGuidance: registration.usageGuidance,
        importance: 'SECONDARY',
        intakeUpload: verifiedUpload,
        placeLinks: [{ placeId: 'place-1' }],
        knowledgeLinks: [{ knowledgeEntryId: 'knowledge-1' }],
        reviews: [{ action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
      },
      {
        id: '7aac469a-3274-41bd-b397-c23620723162',
        kind: 'IMAGE',
        semanticDescription: 'Withdrawn image',
        depictedSubjects: [],
        altText: 'Withdrawn image',
        caption: null,
        usageGuidance: null,
        importance: 'SECONDARY',
        intakeUpload: verifiedUpload,
        placeLinks: [],
        knowledgeLinks: [],
        reviews: [{ action: 'WITHDRAW_CONTENT_USE', rightsBasis: null }],
      },
    ])
    const result = await resolveApprovedVenueMediaCandidates({
      db: client as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      assetId: registration.assetId,
      delivery: 'CONTROLLED_DERIVATIVE_REQUIRED',
    })
    expect(JSON.stringify(result)).not.toMatch(/objectKey|sourceUrl|intakeUploadId|https?:/u)
  })

  it('creates exact source- and review-bound derivative requests without delivery locators', async () => {
    tx.venueMediaAsset.findFirst.mockResolvedValue({
      id: registration.assetId,
      intakeUpload: verifiedUpload,
      reviews: [{ sequence: 1, action: 'APPROVE_CONTENT_USE', rightsBasis: 'VENUE_OWNED' }],
    })
    tx.venueMediaDerivative.findMany.mockReset().mockResolvedValueOnce([])
    tx.venueMediaDerivative.createMany.mockImplementation(async ({ data }) => {
      const requestHash = data[0].requestHash
      tx.venueMediaDerivative.findMany.mockResolvedValueOnce(
        ['CARD', 'DETAIL'].map((variant, index) => ({
          id:
            index === 0
              ? '11111111-1111-4111-8111-111111111111'
              : '22222222-2222-4222-8222-222222222222',
          venueId: 'venue-1',
          assetId: registration.assetId,
          requestHash,
          variant,
          status: 'PENDING',
        })),
      )
      return { count: 2 }
    })

    const result = await requestVenueMediaDerivativesAction({
      db: client as never,
      actor,
      request: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        assetId: registration.assetId,
        requestId: '33333333-3333-4333-8333-333333333333',
        expectedLatestReviewSequence: 1,
        variants: ['CARD', 'DETAIL'],
      },
    })
    expect(tx.venueMediaDerivative.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          variant: 'CARD',
          sourceObjectGeneration: verifiedUpload.objectGeneration,
          sourceStorageVersionId: 'source-version-1',
          approvedReviewSequence: 1,
        }),
      ]),
    })
    expect(result).toMatchObject({ replayed: false })
    expect(result.items).toHaveLength(2)
    expect(JSON.stringify(result)).not.toMatch(/objectKey|storageVersionId|https?:/u)
  })

  it('rejects derivative generation after the approval sequence changes', async () => {
    tx.venueMediaAsset.findFirst.mockResolvedValue({
      id: registration.assetId,
      intakeUpload: verifiedUpload,
      reviews: [{ sequence: 2, action: 'WITHDRAW_CONTENT_USE', rightsBasis: null }],
    })
    await expect(
      requestVenueMediaDerivativesAction({
        db: client as never,
        actor,
        request: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          assetId: registration.assetId,
          requestId: '44444444-4444-4444-8444-444444444444',
          expectedLatestReviewSequence: 1,
          variants: ['CARD'],
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.venueMediaDerivative.createMany).not.toHaveBeenCalled()
  })
})
