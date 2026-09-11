import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { mediaIntakeHash } from './media-intake-snapshot'
import {
  MediaTemporalReviewError,
  MediaTemporalReviewInput,
  previewMediaTemporalReview,
} from './media-temporal-review'

const generation = '22222222-2222-4222-8222-222222222222'
const updatedAt = new Date('2026-09-07T10:00:00.000Z')
const observation = {
  kind: 'visible_text',
  statement: 'Holiday hours: 10–4',
  evidenceChannel: 'visible_text',
  directness: 'observed',
  confidence: 'confirmed',
  processingMethod: 'provider_image_analysis',
  locator: { type: 'whole_source' },
}
const draft = {
  schemaVersion: 1,
  places: [{ name: 'Greenhouse', type: 'room', tags: [], importanceScore: 0 }],
  knowledgeEntries: [{ title: 'Parking', category: 'arrival', content: 'Use the north lot.' }],
}
const finding = {
  sourceId: 'poster',
  filename: 'hours.png',
  mediaType: 'IMAGE',
  summary: 'A photographed hours poster.',
  uncertainties: [],
  sourceObservations: [observation],
}
const valueHash = (value: string) => createHash('sha256').update(value).digest('hex')
const makeClaim = (id: string, value: string) => ({
  claimId: id,
  targetKey: 'place:greenhouse:hours',
  targetItemHash: mediaIntakeHash(draft.places[0]),
  claimType: 'STABLE_FACT' as 'STABLE_FACT' | 'TEMPORARY_SCHEDULE',
  value,
  valueHash: valueHash(value),
  authority: 'AUTHORIZED_STAFF' as const,
  consequential: true,
  effectiveFrom: undefined as string | undefined,
  effectiveUntil: undefined as string | undefined,
  source: {
    sourceId: 'poster',
    sourceSha256: 'a'.repeat(64),
    sourceVersion: 'upload-attempt-1',
    capturedAt: null,
    observationIndex: 0,
    observationSha256: mediaIntakeHash(observation),
  },
})
function fixture() {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: 'project-a',
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        updatedAt,
        sourceGeneration: generation,
        uploadAttemptId: 'upload-attempt-1',
        sourceObjectKey: 'tenant/venue/generation',
        draftJson: draft,
        findings: [finding],
      },
    ]),
    mediaIngestionAsset: {
      findMany: vi.fn().mockResolvedValue([{ sourceId: 'poster', sha256: 'a'.repeat(64) }]),
    },
  }
  return {
    db: { $transaction: vi.fn((callback) => callback(tx)) },
    tx,
    input: {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      projectId: 'project-a',
      sourceGeneration: generation,
      expectedUpdatedAt: updatedAt.toISOString(),
      claims: [makeClaim('open', 'Open'), makeClaim('closed', 'Closed')],
    },
  }
}

describe('previewMediaTemporalReview', () => {
  it('normalizes generation identity and expected review time before comparison', () => {
    const { input } = fixture()
    const parsed = MediaTemporalReviewInput.parse({
      ...input,
      sourceGeneration: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      expectedUpdatedAt: '2026-09-07T05:00:00-05:00',
    })
    expect(parsed.sourceGeneration).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(parsed.expectedUpdatedAt).toBe('2026-09-07T10:00:00.000Z')
  })
  it('validates current evidence, treats authority as asserted, and blocks only the target item', async () => {
    const { db, tx, input } = fixture()
    const result = await previewMediaTemporalReview({
      db: db as never,
      input,
      evaluatedAt: '2026-09-07T12:00:00.000Z',
    })
    expect(result.authorityBasis).toBe('REVIEW_ASSERTED')
    expect(result.authorityVerified).toBe(false)
    expect(result.reviewAssertions).toEqual([
      {
        claimId: 'open',
        assertedAuthority: 'AUTHORIZED_STAFF',
        authorityStatus: 'REVIEW_ASSERTED',
      },
      {
        claimId: 'closed',
        assertedAuthority: 'AUTHORIZED_STAFF',
        authorityStatus: 'REVIEW_ASSERTED',
      },
    ])
    expect(result.reconciliation).toMatchObject({
      blockedTargetKeys: ['place:greenhouse:hours'],
      comparisonCount: 1,
      comparisonsTruncated: false,
    })
    expect(result.reviewReceiptHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result.items).toEqual([
      expect.objectContaining({
        kind: 'place',
        status: 'LOCALLY_BLOCKED',
        handoffStatus: 'HELD',
        holdReasons: ['CONFLICT'],
      }),
      expect.objectContaining({
        kind: 'knowledge',
        status: 'ELIGIBLE',
        handoffStatus: 'ELIGIBLE',
        holdReasons: [],
      }),
    ])
    expect(tx.mediaIngestionAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', projectId: 'project-a' }),
        take: 101,
      }),
    )
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    })
  })

  it('reports a date-bound item as held even when reconciliation has no conflict', async () => {
    const { db, input } = fixture()
    input.claims = [
      {
        ...makeClaim('holiday-hours', 'Open 10–4'),
        claimType: 'TEMPORARY_SCHEDULE',
        effectiveFrom: '2026-09-01T00:00:00.000Z',
        effectiveUntil: '2026-09-30T00:00:00.000Z',
      },
    ]
    const result = await previewMediaTemporalReview({
      db: db as never,
      input,
      evaluatedAt: '2026-09-07T12:00:00.000Z',
    })
    expect(result.items[0]).toMatchObject({
      status: 'ELIGIBLE',
      handoffStatus: 'HELD',
      holdReasons: ['DATE_BOUND'],
    })
  })

  it('reports historical-only evidence as lacking current support', async () => {
    const { db, input } = fixture()
    input.claims = [
      {
        ...makeClaim('expired-hours', 'Open 10–4 last month'),
        effectiveUntil: '2026-08-31T23:59:59.000Z',
      },
    ]
    const result = await previewMediaTemporalReview({
      db: db as never,
      input,
      evaluatedAt: '2026-09-07T12:00:00.000Z',
    })
    expect(result.items[0]).toMatchObject({
      status: 'ELIGIBLE',
      handoffStatus: 'HELD',
      holdReasons: ['DATE_BOUND', 'NO_CURRENT_SUPPORT'],
    })
  })

  it.each([
    [
      'asset SHA',
      (input: ReturnType<typeof fixture>['input']) =>
        (input.claims[0]!.source.sourceSha256 = 'b'.repeat(64)),
    ],
    [
      'observation hash',
      (input: ReturnType<typeof fixture>['input']) =>
        (input.claims[0]!.source.observationSha256 = 'c'.repeat(64)),
    ],
    [
      'source version',
      (input: ReturnType<typeof fixture>['input']) =>
        (input.claims[0]!.source.sourceVersion = 'stale-attempt'),
    ],
    [
      'draft item hash',
      (input: ReturnType<typeof fixture>['input']) =>
        (input.claims[0]!.targetItemHash = 'd'.repeat(64)),
    ],
  ])('rejects a stale or tampered %s', async (_label, mutate) => {
    const { db, input } = fixture()
    mutate(input)
    await expect(
      previewMediaTemporalReview({
        db: db as never,
        input,
        evaluatedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(MediaTemporalReviewError)
  })

  it('rejects a changed project generation before reading assets', async () => {
    const { db, tx, input } = fixture()
    tx.$queryRaw.mockResolvedValueOnce([
      {
        id: 'project-a',
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        updatedAt,
        sourceGeneration: '33333333-3333-4333-8333-333333333333',
        uploadAttemptId: 'upload-attempt-1',
        sourceObjectKey: 'tenant/venue/generation',
        draftJson: draft,
        findings: [finding],
      },
    ])
    await expect(
      previewMediaTemporalReview({
        db: db as never,
        input,
        evaluatedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.mediaIngestionAsset.findMany).not.toHaveBeenCalled()
  })

  it('uses asserted authority only as an unverified conditional recommendation', async () => {
    const { db, input } = fixture()
    ;(input.claims[1] as { authority: string }).authority = 'PUBLIC_SOURCE'
    const result = await previewMediaTemporalReview({
      db: db as never,
      input,
      evaluatedAt: '2026-09-07T12:00:00.000Z',
    })
    expect(result).toMatchObject({
      authorityBasis: 'REVIEW_ASSERTED',
      authorityVerified: false,
      reconciliation: {
        selectedClaimIds: ['open'],
        comparisons: [{ disposition: 'RECOMMENDED_AUTHORITY' }],
      },
    })
  })

  it('reads a legacy timed observation without inventing new observation provenance', async () => {
    const { db, tx, input } = fixture()
    const legacyObservation = {
      kind: 'visible_text',
      statement: 'Holiday hours: 10–4',
      evidenceChannel: 'visible_text',
      directness: 'observed',
      confidence: 'confirmed',
      startSeconds: 0,
      endSeconds: 1,
    }
    input.claims.forEach((claim) => {
      claim.source.observationSha256 = mediaIntakeHash(legacyObservation)
    })
    tx.$queryRaw.mockResolvedValueOnce([
      {
        id: 'project-a',
        status: 'READY_FOR_REVIEW',
        stage: 'review',
        updatedAt,
        sourceGeneration: generation,
        uploadAttemptId: 'upload-attempt-1',
        sourceObjectKey: 'tenant/venue/generation',
        draftJson: draft,
        findings: [
          {
            ...finding,
            filename: 'hours.mp4',
            mediaType: 'VIDEO',
            videoAnalysisMethod: 'GOOGLE_COMPLETE_VIDEO',
            sourceObservations: undefined,
            observations: [legacyObservation],
          },
        ],
      },
    ])
    await expect(
      previewMediaTemporalReview({
        db: db as never,
        input,
        evaluatedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).resolves.toMatchObject({ authorityVerified: false })
  })

  it('rejects duplicate current assets instead of selecting one arbitrarily', async () => {
    const { db, tx, input } = fixture()
    tx.mediaIngestionAsset.findMany.mockResolvedValueOnce([
      { sourceId: 'poster', sha256: 'a'.repeat(64) },
      { sourceId: 'poster', sha256: 'a'.repeat(64) },
    ])
    await expect(
      previewMediaTemporalReview({
        db: db as never,
        input,
        evaluatedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  })
})
