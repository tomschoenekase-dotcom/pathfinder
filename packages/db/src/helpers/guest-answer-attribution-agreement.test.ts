import { describe, expect, it, vi } from 'vitest'

import { readGuestAnswerAttributionAgreement } from './guest-answer-attribution-agreement'

const answerHash = 'a'.repeat(64)
const evidenceSetHash = 'b'.repeat(64)
const snapshot = {
  schemaVersion: 'guest-answer-attribution-v1',
  answerHash,
  evidenceSetHash,
  evaluator: {
    provider: 'human-review',
    model: 'platform-admin',
    configurationVersion: 'review-form-v1',
    promptVersion: 'claim-rubric-v1',
  },
  claims: [
    {
      start: 0,
      end: 4,
      text: 'Open',
      support: 'SUPPORTED',
      sourceIds: ['source-1'],
      rationale: 'The exact frozen source supports this span.',
    },
  ],
  metrics: {
    claimCount: 1,
    supportedCount: 1,
    unsupportedCount: 0,
    uncertainCount: 0,
    nonFactualCount: 0,
    supportRate: 1,
  },
}

describe('guest answer attribution agreement read', () => {
  it('returns a deterministic, bounded, threshold-free calibration report', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: '30000000-0000-4000-8000-000000000001',
        guestChatTurnId: '20000000-0000-4000-8000-000000000001',
        answerHash,
        evidenceSetHash,
        attributionSnapshot: snapshot,
        actorId: 'reviewer-a',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      {
        id: '30000000-0000-4000-8000-000000000002',
        guestChatTurnId: '20000000-0000-4000-8000-000000000001',
        answerHash,
        evidenceSetHash,
        attributionSnapshot: snapshot,
        actorId: 'reviewer-b',
        createdAt: new Date('2026-08-25T00:01:00.000Z'),
      },
    ])

    const result = await readGuestAnswerAttributionAgreement(
      { tenantId: 'tenant-1', venueId: 'venue-1', limit: 100 },
      { guestAnswerAttribution: { findMany } } as never,
    )

    expect(result.report.independentPairCount).toBe(1)
    expect(result.report.metrics.supportAgreementRate).toBe(1)
    expect(result.reportHash).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.interpretation).toEqual({
      establishesCorrectness: false,
      appliesQualityThreshold: false,
      authorizesRelease: false,
    })
    expect(result).not.toHaveProperty('passed')
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 101,
        where: { tenantId: 'tenant-1', venueId: 'venue-1', actorType: 'HUMAN' },
      }),
    )
  })

  it('counts malformed records and reports truncation without treating them as evidence', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: '30000000-0000-4000-8000-000000000003',
        guestChatTurnId: '20000000-0000-4000-8000-000000000002',
        answerHash,
        evidenceSetHash,
        attributionSnapshot: { schemaVersion: 'unknown' },
        actorId: 'reviewer-a',
        createdAt: new Date('2026-08-25T00:00:00.000Z'),
      },
      { id: 'truncation-sentinel' },
      { id: 'beyond-limit' },
    ])

    const result = await readGuestAnswerAttributionAgreement(
      { tenantId: 'tenant-1', venueId: 'venue-1', limit: 2 },
      { guestAnswerAttribution: { findMany } } as never,
    )

    expect(result.truncated).toBe(true)
    expect(result.invalidRecordCount).toBe(2)
    expect(result.report.inputRecordCount).toBe(0)
  })

  it('rejects an unbounded direct-call limit before reading the database', async () => {
    const findMany = vi.fn()
    await expect(
      readGuestAnswerAttributionAgreement(
        { tenantId: 'tenant-1', venueId: 'venue-1', limit: 101 },
        { guestAnswerAttribution: { findMany } } as never,
      ),
    ).rejects.toThrow(/integer from 2 to 100/u)
    expect(findMany).not.toHaveBeenCalled()
  })
})
