import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { getIntakeProposalReview } from './intake-actions'

const privateText = 'Private evacuation instructions'
const publicHash = createHash('sha256')
  .update('operations.hours:PUBLIC_CANDIDATE:Open nine to five.')
  .digest('hex')

function client(run: unknown) {
  return {
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue-a' }) },
    intakeRun: { findFirst: vi.fn().mockResolvedValue(run) },
  }
}

describe('staff interview review projection', () => {
  it('returns INVALID_INPUT before database work for non-string direct inputs', async () => {
    const db = client(null)
    await expect(
      getIntakeProposalReview({
        db: db as never,
        tenantId: 42,
        venueId: {},
        runId: [],
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(db.venue.findFirst).not.toHaveBeenCalled()
    expect(db.intakeRun.findFirst).not.toHaveBeenCalled()
  })

  it('returns public text and safe private/redacted summaries without hashes or raw private text', async () => {
    const db = client({
      id: 'run-1',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Operations interview',
      interviewRole: 'OPERATIONS',
      interviewConsentTextHash: 'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6',
      interviewPublicAnswers: [
        {
          questionId: 'operations.hours',
          text: 'Open nine to five.',
          privacy: 'PUBLIC_CANDIDATE',
          confidence: 0.8,
        },
      ],
      interviewAnswerManifest: [
        {
          questionId: 'operations.hours',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: publicHash,
        },
        {
          questionId: 'operations.closures',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: true,
          redacted: false,
          uncertain: true,
          confidence: 0.5,
          normalizedHash: null,
        },
        {
          questionId: 'operations.internal-procedures',
          privacy: 'PRIVATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: 'b'.repeat(64),
        },
      ],
      evidence: [
        {
          id: 'evidence-1',
          locator: 'interview:question:operations.hours:PUBLIC_CANDIDATE',
          sourceKind: 'INTERVIEW',
          normalizedHash: publicHash,
          confidence: 0.8,
          capturedAt: new Date(),
        },
        {
          id: 'evidence-2',
          sourceKind: 'INTERVIEW',
          locator: 'interview:question:operations.internal-procedures:PRIVATE',
          normalizedHash: 'b'.repeat(64),
          confidence: 0.8,
          capturedAt: new Date(),
        },
      ],
      events: [{ id: 'event-1', kind: 'PROPOSAL_CREATED', createdAt: new Date() }],
      createdAt: new Date(),
    })
    const result = await getIntakeProposalReview({
      db: db as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    expect(result.answers[0]?.publicText).toBe('Open nine to five.')
    expect(result.answers[0]?.fieldPath).toBe('venue.operations.hours')
    expect(result.answers[1]?.discrepancies).toEqual(['MISSING_CONTEXT', 'LOW_CONFIDENCE'])
    expect(result.answers[2]).toMatchObject({
      fieldPath: 'internal.operationalProcedures',
      privacy: 'PRIVATE',
      publicText: null,
      hasEvidence: true,
    })
    expect(result.structuredSummary).toMatchObject({
      candidateFields: [
        expect.objectContaining({
          fieldPath: 'venue.operations.hours',
          publicText: 'Open nine to five.',
        }),
      ],
      flaggedFields: [expect.objectContaining({ fieldPath: 'venue.operations.closures' })],
      withheldFields: expect.arrayContaining([
        expect.objectContaining({
          fieldPath: 'internal.operationalProcedures',
          reason: 'WITHHELD',
        }),
      ]),
      handoffReady: false,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(privateText)
    expect(serialized).not.toContain('b'.repeat(64))
    expect(serialized).not.toContain('normalizedHash')
  })

  it('fails closed for a public manifest answer missing its public text', async () => {
    const db = client({
      id: 'run-1',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Broken',
      interviewRole: 'EXECUTIVE',
      interviewConsentTextHash: 'a'.repeat(64),
      interviewPublicAnswers: [],
      interviewAnswerManifest: [
        {
          questionId: 'executive.mission',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: 'b'.repeat(64),
        },
      ],
      evidence: [],
      events: [],
      createdAt: new Date(),
    })
    await expect(
      getIntakeProposalReview({
        db: db as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it.each([
    ['invalid consent', 'a'.repeat(64), 'b'.repeat(64), 'b'.repeat(64)],
    [
      'evidence hash mismatch',
      'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6',
      'b'.repeat(64),
      'c'.repeat(64),
    ],
    [
      'public text hash mismatch',
      'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6',
      'b'.repeat(64),
      'b'.repeat(64),
    ],
  ])('fails closed for %s', async (_case, consentHash, manifestHash, evidenceHash) => {
    const db = client({
      id: 'run-1',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Executive interview',
      interviewRole: 'EXECUTIVE',
      interviewConsentTextHash: consentHash,
      interviewPublicAnswers: [
        {
          questionId: 'executive.mission',
          text: 'Public mission.',
          privacy: 'PUBLIC_CANDIDATE',
          confidence: 0.8,
        },
      ],
      interviewAnswerManifest: [
        {
          questionId: 'executive.mission',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: false,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: manifestHash,
        },
        {
          questionId: 'executive.priorities',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: true,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
        {
          questionId: 'executive.internal-risks',
          privacy: 'INTERNAL_CONTEXT',
          skipped: false,
          redacted: true,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
      ],
      evidence: [
        {
          id: 'evidence-1',
          sourceKind: 'INTERVIEW',
          locator: 'interview:question:executive.mission:PUBLIC_CANDIDATE',
          normalizedHash: evidenceHash,
          confidence: 0.8,
          capturedAt: new Date(),
        },
      ],
      events: [],
      createdAt: new Date(),
    })
    await expect(
      getIntakeProposalReview({
        db: db as never,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
