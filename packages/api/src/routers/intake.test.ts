import { beforeEach, describe, expect, it, vi } from 'vitest'

import { STAFF_INTERVIEW_CONSENT_TEXT } from '@pathfinder/contracts/staff-interview'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { intakeRouter } from './intake'

const mocks = vi.hoisted(() => ({
  venue: vi.fn(),
  venueCreate: vi.fn(),
  runCreate: vi.fn(),
  runFind: vi.fn(),
  evidenceCreate: vi.fn(),
  eventCreate: vi.fn(),
  draftFind: vi.fn(),
  handoffCreate: vi.fn(),
  auditCreate: vi.fn(),
  executeRaw: vi.fn(),
}))
const db = {
  venue: { findFirst: mocks.venue, create: mocks.venueCreate },
  intakeRun: { create: mocks.runCreate, findMany: vi.fn(), findFirst: mocks.runFind },
  intakeEvidenceRecord: { create: mocks.evidenceCreate },
  intakeRunEvent: { create: mocks.eventCreate },
  venuePackage: { findFirst: mocks.draftFind },
  intakePackageHandoff: { create: mocks.handoffCreate },
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

  it('rejects a cross-tenant venue before writing', async () => {
    mocks.venue.mockResolvedValue(null)
    await expect(
      caller.createCaller(context('tenant-a')).intake.createProposal({
        venueId: 'venue-b',
        kind: 'WEBSITE',
        displayName: 'Site',
        websiteUri: 'https://example.com',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.runCreate).not.toHaveBeenCalled()
  })

  it('links only an exact-scope package already in DRAFT status', async () => {
    mocks.runFind.mockResolvedValue({ id: 'run-1' })
    mocks.draftFind.mockResolvedValue({ id: 'draft-1' })
    mocks.handoffCreate.mockResolvedValue({
      id: 'handoff-1',
      runId: 'run-1',
      packageDraftId: 'draft-1',
      createdAt: new Date(),
    })
    await caller
      .createCaller(context())
      .intake.linkPackageDraft({ venueId: 'venue-a', runId: 'run-1', packageDraftId: 'draft-1' })
    expect(mocks.draftFind).toHaveBeenCalledWith({
      where: { id: 'draft-1', tenantId: 'tenant-a', venueId: 'venue-a', status: 'DRAFT' },
      select: { id: true },
    })
    expect(mocks.handoffCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a' }),
      }),
    )
  })
})
