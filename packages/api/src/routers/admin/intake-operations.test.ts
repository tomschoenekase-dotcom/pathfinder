import { beforeEach, describe, expect, it, vi } from 'vitest'

const reviewedDraft = vi.hoisted(() => ({ orchestrate: vi.fn() }))
vi.mock('../../lib/admin-reviewed-draft-orchestration', () => ({
  runAdminReviewedDraftOrchestration: reviewedDraft.orchestrate,
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { adminIntakeOperationsRouter } from './intake-operations'

const venueFindFirst = vi.fn()
const runFindMany = vi.fn()
const runFindFirst = vi.fn()
const runCreate = vi.fn()
const eventCreate = vi.fn()
const executeRaw = vi.fn()
const auditCreate = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  intakeRun: { findMany: runFindMany, findFirst: runFindFirst, create: runCreate },
  intakeRunEvent: { create: eventCreate },
  auditLog: { create: auditCreate },
  $executeRaw: executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
} as unknown as TRPCContext['db']

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: { userId: 'platform-admin', activeTenantId: null, role: null, isPlatformAdmin },
  }
}

const testRouter = router({ operations: adminIntakeOperationsRouter })

describe('platform admin intake operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runFindMany.mockResolvedValue([])
    runFindFirst.mockResolvedValue(null)
    executeRaw.mockResolvedValue(1)
    runCreate.mockResolvedValue({
      id: 'run-1',
      venueId: 'venue-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      displayName: 'Site',
      createdAt: new Date(),
    })
  })

  it('adapts atomic intake-to-new-DRAFT orchestration in exact scope', async () => {
    reviewedDraft.orchestrate.mockResolvedValue({ value: { id: 'package_1' }, attachment: {} })
    const payload = {
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        { title: 'Hours', category: 'FAQ', content: 'Current hours.', isEnabled: true },
      ],
    }
    await testRouter
      .createCaller(context())
      .operations.createAndLinkIntakeReviewedVenuePackageDraft({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        intakeRunId: 'run-1',
        draftKey: '11111111-1111-4111-8111-111111111111',
        payload,
      })
    expect(reviewedDraft.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        draft: expect.objectContaining({ venueId: 'venue-a', payload }),
        finalizer: expect.any(Function),
      }),
    )
  })

  it('blocks non-admin callers before database access', async () => {
    await expect(
      testRouter
        .createCaller(context(false))
        .operations.listIntakeProposals({ tenantId: 'tenant-a', venueId: 'venue-a' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('rejects a cross-tenant venue before reading intake rows', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      testRouter
        .createCaller(context())
        .operations.listIntakeProposals({ tenantId: 'tenant-a', venueId: 'venue-b' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue-b', tenantId: 'tenant-a' },
      select: { id: true },
    })
    expect(runFindMany).not.toHaveBeenCalled()
  })

  it('uses the canonical action with exact scope and remains draft-only', async () => {
    const result = await testRouter.createCaller(context()).operations.createIntakeProposal({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      requestId: '56d3ed81-d294-4051-abd2-0e1a77f61ec7',
      kind: 'WEBSITE',
      displayName: 'Site',
      websiteUri: 'https://example.com',
    })
    expect(runCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          status: 'AWAITING_REVIEW',
          requestedBy: 'platform-admin',
        }),
      }),
    )
    expect(result).toMatchObject({ autoApprove: false, autoApply: false })
  })

  it('exposes private onboarding payload only through exact platform review scope', async () => {
    runFindMany.mockResolvedValue([
      {
        id: 'run-1',
        venueId: 'venue-a',
        status: 'AWAITING_REVIEW',
        displayName: 'Museum onboarding information',
        structuredBootstrap: { version: 1, content: { kind: 'knowledge' } },
        createdAt: new Date(),
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .operations.listOnboardingBootstrapDetails({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        limit: 10,
      })
    expect(runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: 'STRUCTURED_BOOTSTRAP',
        },
      }),
    )
    expect(result[0]?.structuredBootstrap).toEqual({
      version: 1,
      content: { kind: 'knowledge' },
    })
  })

  it('gates interview detail before DB access and binds exact tenant/venue/run scope', async () => {
    await expect(
      testRouter.createCaller(context(false)).operations.getIntakeProposalReview({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(venueFindFirst).not.toHaveBeenCalled()

    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      displayName: 'Interview',
      interviewRole: 'CONTENT',
      interviewConsentTextHash: 'a5cf3db6904cd5191ac3cad19554ca19357c660da36636b0dd11a0dd37dabab6',
      interviewPublicAnswers: [],
      interviewAnswerManifest: [
        {
          questionId: 'content.voice',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: true,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
        {
          questionId: 'content.terminology',
          privacy: 'PUBLIC_CANDIDATE',
          skipped: true,
          redacted: false,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
        {
          questionId: 'content.embargoed',
          privacy: 'PRIVATE',
          skipped: false,
          redacted: true,
          uncertain: false,
          confidence: 0.8,
          normalizedHash: null,
        },
      ],
      evidence: [],
      events: [],
      createdAt: new Date(),
    })
    const result = await testRouter.createCaller(context()).operations.getIntakeProposalReview({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    expect(runFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-1', tenantId: 'tenant-a', venueId: 'venue-a', sourceKind: 'INTERVIEW' },
      }),
    )
    expect(result.answers[2]).toMatchObject({
      redacted: true,
      publicText: null,
      hasEvidence: false,
    })
  })
})
