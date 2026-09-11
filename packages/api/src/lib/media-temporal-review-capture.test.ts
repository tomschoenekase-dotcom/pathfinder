import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { VenuePackagePayloadV1 } from '@pathfinder/contracts'
import { captureMediaTemporalReview } from './media-temporal-review-capture'
import { mediaIntakeHash } from './media-intake-snapshot'
import {
  mediaTemporalReceiptInput,
  validateMediaTemporalReviewSnapshot,
} from './media-temporal-review-receipt'
import { reviewedMediaTemporalOperationalDraft } from './media-temporal-operational-draft'

function fixture() {
  const observation = {
    kind: 'visible_text' as const,
    statement: 'Special week: 10–4',
    evidenceChannel: 'visible_text' as const,
    directness: 'observed' as const,
    confidence: 'confirmed' as const,
    processingMethod: 'provider_image_analysis' as const,
    locator: { type: 'whole_source' as const },
  }
  const draft = VenuePackagePayloadV1.parse({
    schemaVersion: 1,
    places: [],
    knowledgeEntries: [
      { title: 'Special hours', category: 'hours', content: 'Special week: 10–4' },
    ],
  })
  const value = 'Special week: 10–4'
  const input = {
    tenantId: 'tenant',
    venueId: 'venue',
    projectId: 'project',
    sourceGeneration: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    expectedUpdatedAt: '2026-09-07T09:00:00.000Z',
    rationale: 'Confirmed the dated placard.',
    claims: [
      {
        claimId: 'special-hours',
        targetKey: 'hours',
        targetItemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        value,
        valueHash: createHash('sha256').update(value).digest('hex'),
        claimType: 'TEMPORARY_SCHEDULE' as const,
        authority: 'AUTHORIZED_STAFF' as const,
        consequential: true,
        effectiveFrom: '2026-09-08T00:00:00.000Z',
        effectiveUntil: '2026-09-15T00:00:00.000Z',
        source: {
          sourceId: 'placard',
          sourceSha256: 'a'.repeat(64),
          sourceVersion: 'upload',
          capturedAt: null,
          observationIndex: 0,
          observationSha256: mediaIntakeHash(observation),
        },
      },
    ],
    bindings: [
      {
        kind: 'knowledge' as const,
        itemIndex: 0,
        itemHash: mediaIntakeHash(draft.knowledgeEntries[0]),
        sourceIds: ['placard'],
      },
    ],
  }
  return {
    input,
    actorId: 'reviewer',
    uploadAttemptId: 'upload',
    evaluatedAt: '2026-09-07T10:00:00.000Z',
    draft,
    findings: [
      {
        sourceId: 'placard',
        filename: 'placard.png',
        mediaType: 'IMAGE',
        summary: 'Dated hours.',
        uncertainties: [],
        sourceObservations: [observation],
      },
    ],
    assets: [
      {
        id: 'asset',
        sourceId: 'placard',
        filename: 'placard.png',
        mediaType: 'IMAGE',
        sha256: 'a'.repeat(64),
        status: 'COMPLETE',
      },
    ],
  }
}

describe('compact all-held temporal evidence', () => {
  it('retains only cited evidence and supports an all-held dated draft without a Builder run', () => {
    const source = fixture()
    const snapshot = captureMediaTemporalReview(source)
    expect(mediaTemporalReceiptInput(snapshot)).toEqual(source.input)
    expect(snapshot).not.toHaveProperty('draft')
    expect(snapshot.sources[0]!.observations).toHaveLength(1)
    expect(
      reviewedMediaTemporalOperationalDraft({
        snapshot,
        expectedSnapshotHash: mediaIntakeHash(snapshot),
        claimId: 'special-hours',
        now: source.evaluatedAt,
      }),
    ).toMatchObject({ status: 'DRAFT', isActive: false })
  })
  it('freezes evidence independently of later source and draft mutations', () => {
    const source = fixture()
    const snapshot = captureMediaTemporalReview(source)
    const hash = mediaIntakeHash(snapshot)
    source.findings[0]!.sourceObservations[0]!.statement = 'Edited later'
    source.draft.knowledgeEntries[0]!.content = 'Edited later'
    expect(mediaIntakeHash(validateMediaTemporalReviewSnapshot(snapshot))).toBe(hash)
  })
  it('rejects changed item identity, source version, observation, duplicate and missing evidence', () => {
    for (const mutate of [
      (source: ReturnType<typeof fixture>) => {
        source.input.bindings[0]!.itemIndex = 1
      },
      (source: ReturnType<typeof fixture>) => {
        source.uploadAttemptId = 'new-upload'
      },
      (source: ReturnType<typeof fixture>) => {
        source.findings[0]!.sourceObservations[0]!.statement = 'Different hours'
      },
      (source: ReturnType<typeof fixture>) => {
        source.assets.push(source.assets[0]!)
      },
      (source: ReturnType<typeof fixture>) => {
        source.assets[0]!.status = 'FAILED'
      },
      (source: ReturnType<typeof fixture>) => {
        source.input.bindings[0]!.sourceIds.push('uncited-source')
      },
    ]) {
      const source = fixture()
      mutate(source)
      expect(() => captureMediaTemporalReview(source)).toThrow()
    }
  })
  it('rejects a changed reconciliation or extra uncited observation in a retained receipt', () => {
    const snapshot = captureMediaTemporalReview(fixture())
    expect(() =>
      validateMediaTemporalReviewSnapshot({
        ...snapshot,
        temporalReview: { ...snapshot.temporalReview, reconciliationHash: 'f'.repeat(64) },
      }),
    ).toThrow('reconciliation')
    snapshot.sources[0]!.observations.push({ ...snapshot.sources[0]!.observations[0]!, index: 2 })
    expect(() => validateMediaTemporalReviewSnapshot(snapshot)).toThrow('only cited')
  })
})
