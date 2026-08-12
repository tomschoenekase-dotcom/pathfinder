import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { intakeRouter } from './intake'

const publicReviewHash = createHash('sha256')
  .update('operations.hours:PUBLIC_CANDIDATE:Open daily.')
  .digest('hex')

const mocks = vi.hoisted(() => ({
  venue: vi.fn(),
  venueCreate: vi.fn(),
  runCreate: vi.fn(),
  runFind: vi.fn(),
  evidenceCreate: vi.fn(),
  eventCreate: vi.fn(),
  auditCreate: vi.fn(),
  executeRaw: vi.fn(),
}))
const db = {
  venue: { findFirst: mocks.venue, create: mocks.venueCreate },
  intakeRun: { create: mocks.runCreate, findMany: vi.fn(), findFirst: mocks.runFind },
  intakeEvidenceRecord: { create: mocks.evidenceCreate },
  intakeRunEvent: { create: mocks.eventCreate },
  auditLog: { create: mocks.auditCreate },
  $executeRaw: mocks.executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
} as unknown as TRPCContext['db']

function context(tenantId = 'tenant-a'): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'user-1', activeTenantId: tenantId, role: 'OWNER', isPlatformAdmin: false },
  }
}
const caller = router({ intake: intakeRouter })

describe('intake draft proposals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venue.mockResolvedValue({ id: 'venue-a' })
    mocks.executeRaw.mockResolvedValue(1)
    mocks.runFind.mockResolvedValue(null)
    mocks.runCreate.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Interview',
      createdAt: new Date(),
    })
  })

  it('adapts an owner onboarding submission to an inactive empty shell and review-only run', async () => {
    mocks.venue.mockResolvedValueOnce(null)
    mocks.venueCreate.mockResolvedValue({
      id: 'venue-a',
      name: 'Museum',
      slug: 'museum',
      category: null,
      guideMode: 'non_location',
      isActive: false,
      updatedAt: new Date(),
      places: [],
      knowledgeEntries: [],
    })
    mocks.runCreate.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      displayName: 'Museum onboarding information',
      submissionInputHash: 'a'.repeat(64),
      createdAt: new Date(),
      venue: { id: 'venue-a', name: 'Museum', slug: 'museum' },
    })
    const result = await caller.createCaller(context()).intake.submitOnboardingBootstrap({
      requestId: '5d1a79a1-93e0-4af2-88f7-f6cb974a92a4',
      venue: { name: 'Museum', slug: 'museum', guideMode: 'non_location' },
      rawContent: {
        kind: 'knowledge',
        value: { title: 'Hours', category: 'HOURS', content: 'Candidate information.' },
      },
    })
    expect(result).toMatchObject({ status: 'AWAITING_REVIEW', published: false, autoApply: false })
    expect(mocks.venueCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-a', isActive: false }),
      }),
    )
    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ requestedBy: 'user-1' }) }),
    )
  })

  it('persists public text but only hashes classified internal answers', async () => {
    await caller.createCaller(context()).intake.createProposal({
      venueId: 'venue-a',
      requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
      kind: 'INTERVIEW',
      displayName: 'Interview',
      submission: {
        role: 'OPERATIONS',
        consentToUse: true,
        acceptedConsentText: STAFF_INTERVIEW_CONSENT_TEXT,
        answers: [
          {
            questionId: 'operations.hours',
            text: 'Opening hours are nine to five.',
            privacy: 'PUBLIC_CANDIDATE',
          },
          {
            questionId: 'operations.closures',
            privacy: 'PUBLIC_CANDIDATE',
            skipped: true,
          },
          {
            questionId: 'operations.internal-procedures',
            text: 'Sensitive internal instructions.',
            privacy: 'PRIVATE',
          },
        ],
      },
    })
    expect(mocks.venue).toHaveBeenCalledWith({
      where: { id: 'venue-a', tenantId: 'tenant-a' },
      select: { id: true },
    })
    expect(mocks.runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          status: 'AWAITING_REVIEW',
          interviewRole: 'OPERATIONS',
          interviewPublicAnswers: [
            expect.objectContaining({
              questionId: 'operations.hours',
              text: 'Opening hours are nine to five.',
              privacy: 'PUBLIC_CANDIDATE',
            }),
          ],
          interviewAnswerManifest: expect.arrayContaining([
            expect.objectContaining({
              questionId: 'operations.internal-procedures',
              privacy: 'PRIVATE',
              normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ]),
        }),
      }),
    )
    expect(mocks.evidenceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })
    expect(mocks.runCreate.mock.calls[0]?.[0]?.data).not.toHaveProperty('approvedAt')
    expect(JSON.stringify(mocks.runCreate.mock.calls[0]?.[0]?.data)).not.toContain(
      'Sensitive internal instructions.',
    )
    expect(mocks.evidenceCreate).toHaveBeenCalledTimes(2)
  })

  it('requires exact consent and rejects privacy weaker than the role question default', async () => {
    await expect(
      caller.createCaller(context()).intake.createProposal({
        venueId: 'venue-a',
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
        kind: 'INTERVIEW',
        displayName: 'Unsafe interview',
        submission: {
          role: 'OPERATIONS',
          consentToUse: false,
          answers: [
            {
              questionId: 'operations.internal-procedures',
              text: 'Do not persist this.',
              privacy: 'PUBLIC_CANDIDATE',
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.venue).not.toHaveBeenCalled()
    expect(mocks.runCreate).not.toHaveBeenCalled()
  })

  it('returns a privacy-safe exact-scope interview detail and timeline', async () => {
    mocks.runFind.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Operations interview',
      interviewRole: 'OPERATIONS',
      interviewConsentTextHash: 'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6',
      interviewPublicAnswers: [
        {
          questionId: 'operations.hours',
          text: 'Open daily.',
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
          normalizedHash: publicReviewHash,
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
          id: 'e-1',
          sourceKind: 'INTERVIEW',
          locator: 'interview:question:operations.hours:PUBLIC_CANDIDATE',
          normalizedHash: publicReviewHash,
          confidence: 0.8,
          capturedAt: new Date(),
        },
        {
          id: 'e-2',
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
    const result = await caller.createCaller(context()).intake.getProposalReview({
      venueId: 'venue-a',
      runId: 'run-1',
    })
    expect(mocks.runFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'run-1',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: 'INTERVIEW',
        },
      }),
    )
    expect(result.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionId: 'operations.hours',
          publicText: 'Open daily.',
          privacy: 'PUBLIC_CANDIDATE',
        }),
        expect.objectContaining({
          questionId: 'operations.internal-procedures',
          publicText: null,
          privacy: 'PRIVATE',
        }),
      ]),
    )
    expect(JSON.stringify(result)).not.toMatch(
      /"confidence"|"discrepancies"|"structuredSummary"|"timeline"|"evidence"|"fieldPath"|"uncertain"|handoff|normalizedHash|autoApprove|autoApply|published/iu,
    )
    expect(JSON.stringify(result)).not.toContain('b'.repeat(64))
  })

  it('rejects a cross-tenant venue before writing', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      caller.createCaller(context('tenant-a')).intake.createProposal({
        venueId: 'venue-b',
        requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
        kind: 'WEBSITE',
        displayName: 'Site',
        websiteUri: 'https://example.com',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.runCreate).not.toHaveBeenCalled()
  })
})
