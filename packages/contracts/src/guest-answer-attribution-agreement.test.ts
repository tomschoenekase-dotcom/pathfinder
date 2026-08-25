import { describe, expect, it } from 'vitest'

import {
  analyzeGuestAnswerAttributionAgreement,
  GuestAnswerAttributionAgreementRecordSchema,
} from './guest-answer-attribution-agreement'
import type { GuestAnswerAttribution } from './guest-answer-attribution'

const answerHash = 'a'.repeat(64)
const evidenceSetHash = 'b'.repeat(64)

function attribution(
  claims: GuestAnswerAttribution['claims'],
  evaluator = 'reviewer-model',
): GuestAnswerAttribution {
  const factual = claims.filter((claim) => claim.support !== 'NON_FACTUAL')
  const supported = claims.filter((claim) => claim.support === 'SUPPORTED').length
  return {
    schemaVersion: 'guest-answer-attribution-v1',
    answerHash,
    evidenceSetHash,
    evaluator: {
      provider: 'human-review',
      model: evaluator,
      configurationVersion: 'review-form-v1',
      promptVersion: 'claim-rubric-v1',
    },
    claims,
    metrics: {
      claimCount: claims.length,
      supportedCount: supported,
      unsupportedCount: claims.filter((claim) => claim.support === 'UNSUPPORTED').length,
      uncertainCount: claims.filter((claim) => claim.support === 'UNCERTAIN').length,
      nonFactualCount: claims.filter((claim) => claim.support === 'NON_FACTUAL').length,
      supportRate: factual.length === 0 ? null : supported / factual.length,
    },
  }
}

function record(input: {
  id: string
  reviewerId: string
  claims: GuestAnswerAttribution['claims']
  createdAt?: string
  turnId?: string
  answer?: string
  evidence?: string
}) {
  const snapshot = attribution(input.claims)
  if (input.answer) snapshot.answerHash = input.answer
  if (input.evidence) snapshot.evidenceSetHash = input.evidence
  return {
    attributionId: input.id,
    guestChatTurnId: input.turnId ?? '10000000-0000-4000-8000-000000000001',
    reviewerId: input.reviewerId,
    answerHash: snapshot.answerHash,
    evidenceSetHash: snapshot.evidenceSetHash,
    createdAt: new Date(input.createdAt ?? '2026-08-25T00:00:00.000Z'),
    attribution: snapshot,
  }
}

const supported = (start: number, end: number, text: string, sourceIds = ['source-1']) => ({
  start,
  end,
  text,
  support: 'SUPPORTED' as const,
  sourceIds,
  rationale: 'Exact frozen source supports this span.',
})

describe('guest answer attribution agreement', () => {
  it('compares coverage, support labels, and source sets independently of claim segmentation', () => {
    const report = analyzeGuestAnswerAttributionAgreement([
      record({
        id: '20000000-0000-4000-8000-000000000001',
        reviewerId: 'reviewer-a',
        claims: [supported(0, 6, 'Museum'), supported(6, 11, ' open')],
      }),
      record({
        id: '20000000-0000-4000-8000-000000000002',
        reviewerId: 'reviewer-b',
        claims: [supported(0, 11, 'Museum open')],
      }),
    ])

    expect(report.independentPairCount).toBe(1)
    expect(report.metrics).toEqual({
      annotatedCharacterUnion: 11,
      bothAnnotatedCharacters: 11,
      coverageOverlapRate: 1,
      matchingSupportCharacters: 11,
      supportAgreementRate: 1,
      bothSupportedCharacters: 11,
      matchingSourceCharacters: 11,
      sourceAgreementRate: 1,
    })
  })

  it('reports coverage, support, and source disagreement without producing a pass decision', () => {
    const report = analyzeGuestAnswerAttributionAgreement([
      record({
        id: '20000000-0000-4000-8000-000000000003',
        reviewerId: 'reviewer-a',
        claims: [supported(0, 4, 'Open'), supported(5, 9, 'noon', ['source-1'])],
      }),
      record({
        id: '20000000-0000-4000-8000-000000000004',
        reviewerId: 'reviewer-b',
        claims: [
          supported(0, 4, 'Open'),
          {
            start: 5,
            end: 9,
            text: 'noon',
            support: 'UNSUPPORTED',
            sourceIds: [],
            rationale: 'No frozen source supports this claim.',
          },
          supported(10, 12, 'CT', ['source-2']),
        ],
      }),
    ])

    expect(report.metrics.coverageOverlapRate).toBe(8 / 10)
    expect(report.metrics.supportAgreementRate).toBe(0.5)
    expect(report.metrics.sourceAgreementRate).toBe(1)
    expect(report).not.toHaveProperty('passed')
  })

  it('uses only the newest review per reviewer and exposes identity conflicts', () => {
    const changedAnswerHash = 'c'.repeat(64)
    const report = analyzeGuestAnswerAttributionAgreement([
      record({
        id: '20000000-0000-4000-8000-000000000005',
        reviewerId: 'reviewer-a',
        claims: [supported(0, 4, 'Open')],
        createdAt: '2026-08-24T00:00:00.000Z',
      }),
      record({
        id: '20000000-0000-4000-8000-000000000006',
        reviewerId: 'reviewer-a',
        claims: [supported(0, 4, 'Open')],
        createdAt: '2026-08-25T00:00:00.000Z',
      }),
      record({
        id: '20000000-0000-4000-8000-000000000007',
        reviewerId: 'reviewer-b',
        claims: [supported(0, 4, 'Open')],
      }),
      record({
        id: '20000000-0000-4000-8000-000000000008',
        reviewerId: 'reviewer-c',
        claims: [supported(0, 4, 'Open')],
        answer: changedAnswerHash,
      }),
    ])

    expect(report.exclusions).toEqual({
      repeatedReviewerRecordCount: 1,
      singleReviewerGroupCount: 1,
      identityConflictTurnCount: 1,
    })
    expect(report.selectedRecordCount).toBe(3)
    expect(report.independentPairCount).toBe(1)
  })

  it('rejects a stored identity that contradicts its immutable snapshot', () => {
    const candidate = record({
      id: '20000000-0000-4000-8000-000000000009',
      reviewerId: 'reviewer-a',
      claims: [],
    })
    candidate.answerHash = 'd'.repeat(64)
    expect(() => GuestAnswerAttributionAgreementRecordSchema.parse(candidate)).toThrow(
      /answer hash/i,
    )
  })
})
