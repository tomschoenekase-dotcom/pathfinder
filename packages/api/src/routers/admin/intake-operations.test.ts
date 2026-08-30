import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { onboardingBootstrapInputHash } from '@pathfinder/db'

const reviewedDraft = vi.hoisted(() => ({ orchestrate: vi.fn() }))
const websiteResearch = vi.hoisted(() => ({
  execute: vi.fn(),
  dependencies: { resolveHostname: vi.fn() },
}))
vi.mock('../venue-package', () => ({
  createVenuePackageDraftService: reviewedDraft.orchestrate,
}))
vi.mock('../../lib/website-intake-research-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/website-intake-research-service')>()
  return { ...actual, executeWebsiteIntakeResearch: websiteResearch.execute }
})
vi.mock('../../lib/website-intake-runtime', () => ({
  createWebsiteIntakeRuntimeDependencies: vi.fn(() => websiteResearch.dependencies),
}))

import type { TRPCContext } from '../../context'
import { router } from '../../core'
import { intakeCandidateDraftKey } from '../../lib/intake-venue-package-candidate'
import { WebsiteResearchExecutionError } from '../../lib/website-intake-research-service'
import { adminIntakeOperationsRouter } from './intake-operations'

const venueFindFirst = vi.fn()
const runFindMany = vi.fn()
const runFindFirst = vi.fn()
const runCreate = vi.fn()
const handoffFindFirst = vi.fn()
const eventCreate = vi.fn()
const executeRaw = vi.fn()
const auditCreate = vi.fn()
const db = {
  venue: { findFirst: venueFindFirst },
  intakeRun: { findMany: runFindMany, findFirst: runFindFirst, create: runCreate },
  intakePackageHandoff: { findFirst: handoffFindFirst },
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
const candidateVenue = {
  name: 'Museum',
  slug: 'museum',
  category: null,
  guideMode: 'non_location',
  defaultCenterLat: null,
  defaultCenterLng: null,
}
const candidateHash = onboardingBootstrapInputHash({
  venue: { name: 'Museum', slug: 'museum', guideMode: 'non_location' },
  proposal: {
    version: 1,
    content: {
      kind: 'knowledge',
      value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
    },
  },
})
const candidateEvidence = {
  submissionInputHash: candidateHash,
  venue: candidateVenue,
  evidence: [
    {
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      locator: 'onboarding:structured-bootstrap:v1',
      normalizedHash: candidateHash,
      confidence: 1,
    },
  ],
}

function extractionReviewCandidateRun() {
  const reviewId = '4d8bb6f8-f1d7-42ee-944d-2a628fa50f77'
  const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
  const proposalNotes = 'The east entrance is step-free.'
  const proposalNotesHash = createHash('sha256').update(proposalNotes).digest('hex')
  const requestHash = 'c'.repeat(64)
  const sourceSha256 = 'b'.repeat(64)
  const extractedTextHash = 'a'.repeat(64)
  return {
    id: 'proposal-run-file',
    sourceKind: 'STRUCTURED_BOOTSTRAP',
    status: 'AWAITING_REVIEW',
    displayName: 'Reviewed visitor information',
    structuredBootstrap: {
      kind: 'FILE_EXTRACTION_REVIEW',
      sourceRunId: 'source-run-file',
      receiptId,
      sourceSha256,
      sourceMimeType: 'text/plain',
      extractedTextHash,
      proposalNotes,
      proposalNotesHash,
      reviewRationale: 'The selected statement is clear and relevant.',
    },
    submissionRequestId: reviewId,
    submissionInputHash: requestHash,
    requestedBy: 'platform-admin',
    requestedByType: 'HUMAN',
    packageHandoff: null,
    venue: candidateVenue,
    evidence: [
      {
        sourceKind: 'STRUCTURED_BOOTSTRAP',
        locator: `intake-file-extraction-review:${reviewId}`,
        normalizedHash: proposalNotesHash,
        confidence: 1,
      },
    ],
    fileExtractionProposalReview: {
      id: reviewId,
      sourceRunId: 'source-run-file',
      receiptId,
      requestId: reviewId,
      requestHash,
      decision: 'ACCEPTED_FOR_PROPOSAL',
      expectedExtractedTextHash: extractedTextHash,
      proposalTitle: 'Reviewed visitor information',
      proposalNotes,
      proposalNotesHash,
      rationale: 'The selected statement is clear and relevant.',
      createdBy: 'platform-admin',
      clarificationResolutionCount: 0,
      clarificationResolutionDigest: null,
      receipt: {
        sourceSha256,
        sourceMimeType: 'text/plain',
        clarificationResolutions: [],
      },
    },
  }
}

describe('platform admin intake operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue({ id: 'venue-a' })
    runFindMany.mockResolvedValue([])
    runFindFirst.mockResolvedValue(null)
    handoffFindFirst.mockResolvedValue(null)
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

  it('gates bounded website research and supplies only server-owned execution policy', async () => {
    const operationId = 'a68c2e1a-8ece-47ad-98dc-e4bde64872ca'
    await expect(
      testRouter.createCaller(context(false)).operations.executeWebsiteIntakeResearch({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        operationId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(websiteResearch.execute).not.toHaveBeenCalled()

    websiteResearch.execute.mockResolvedValue({
      receiptId: operationId,
      outcome: 'SUCCEEDED',
      replayed: false,
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
    const result = await testRouter
      .createCaller(context())
      .operations.executeWebsiteIntakeResearch({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        operationId,
      })

    expect(websiteResearch.execute).toHaveBeenCalledWith({
      db,
      request: {
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        operationId,
        maxPages: 5,
        maxDepth: 1,
        maxBytesPerPage: 1_000_000,
        maxDurationMs: 30_000,
        maxCostUnits: 20,
        userAgent: 'TorchikoBuilder/1.0',
        createdBy: 'platform-admin',
      },
      dependencies: websiteResearch.dependencies,
    })
    expect(result).toMatchObject({
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
    })
  })

  it('keeps classified website research rejections actionable for the operator', async () => {
    websiteResearch.execute.mockRejectedValueOnce(
      new WebsiteResearchExecutionError(
        'INVALID_INPUT',
        'Only a website intake run can execute website research.',
      ),
    )

    await expect(
      testRouter.createCaller(context()).operations.executeWebsiteIntakeResearch({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        operationId: 'a68c2e1a-8ece-47ad-98dc-e4bde64872ca',
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'Only a website intake run can execute website research.',
    })
  })

  it('gates candidate projection before DB access and exact-binds the intake source', async () => {
    await expect(
      testRouter.createCaller(context(false)).operations.getIntakeVenuePackageCandidate({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(runFindFirst).not.toHaveBeenCalled()

    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    const result = await testRouter
      .createCaller(context())
      .operations.getIntakeVenuePackageCandidate({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
      })
    expect(runFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'run-1',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
          sourceKind: { in: ['STRUCTURED_BOOTSTRAP', 'INTERVIEW'] },
        },
      }),
    )
    expect(result).toMatchObject({
      ready: true,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      payload: { schemaVersion: 3 },
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      autoApprove: false,
      autoApply: false,
      published: false,
    })
  })

  it('rebuilds and hash-binds the canonical intake payload before draft orchestration', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    const caller = testRouter.createCaller(context())
    const candidate = await caller.operations.getIntakeVenuePackageCandidate({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    runFindFirst.mockClear().mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    reviewedDraft.orchestrate.mockResolvedValue({ value: { id: 'package-1' }, attachment: {} })
    await caller.operations.createAndLinkIntakeCandidateDraft({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
      expectedCandidateHash: candidate.candidateHash!,
    })
    expect(runFindFirst).toHaveBeenCalledTimes(1)
    expect(reviewedDraft.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        input: expect.objectContaining({
          venueId: 'venue-a',
          draftKey: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          payload: candidate.payload,
        }),
        finalizer: expect.any(Function),
      }),
    )
  })

  it('routes an exact extraction-review candidate only into the existing atomic DRAFT orchestrator', async () => {
    const run = extractionReviewCandidateRun()
    runFindFirst.mockResolvedValue(run)
    const caller = testRouter.createCaller(context())
    const candidate = await caller.operations.getIntakeVenuePackageCandidate({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: run.id,
    })
    runFindFirst.mockClear().mockResolvedValue(run)
    reviewedDraft.orchestrate.mockResolvedValue({ value: { id: 'package-file' }, attachment: {} })

    await caller.operations.createAndLinkIntakeCandidateDraft({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: run.id,
      expectedCandidateHash: candidate.candidateHash!,
    })

    expect(reviewedDraft.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          id: 'platform-admin',
          role: 'PLATFORM_ADMIN',
          type: 'HUMAN',
        },
        tenantId: 'tenant-a',
        input: expect.objectContaining({
          venueId: 'venue-a',
          payload: candidate.payload,
        }),
        finalizer: expect.any(Function),
      }),
    )
    expect(candidate).toMatchObject({
      ready: true,
      autoApprove: false,
      autoApply: false,
      published: false,
    })
  })

  it('rejects a stale candidate hash without starting draft orchestration', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    await expect(
      testRouter.createCaller(context()).operations.createAndLinkIntakeCandidateDraft({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        expectedCandidateHash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(reviewedDraft.orchestrate).not.toHaveBeenCalled()
  })

  it('blocks a mismatched existing handoff before draft orchestration', async () => {
    const run = {
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    }
    runFindFirst.mockResolvedValue(run)
    const caller = testRouter.createCaller(context())
    const preview = await caller.operations.getIntakeVenuePackageCandidate({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    runFindFirst.mockResolvedValue({
      ...run,
      packageHandoff: { packageDraftId: 'different-package' },
    })
    handoffFindFirst.mockResolvedValue({
      createdBy: 'another-admin',
      packageDraft: {
        id: 'different-package',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        draftKey: '11111111-1111-4111-8111-111111111111',
        payloadHash: 'b'.repeat(64),
        status: 'DRAFT',
        createdBy: 'another-admin',
      },
    })
    await expect(
      caller.operations.createAndLinkIntakeCandidateDraft({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        expectedCandidateHash: preview.candidateHash!,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(reviewedDraft.orchestrate).not.toHaveBeenCalled()
  })

  it('allows only an exact actor-bound existing handoff to enter orchestration replay', async () => {
    const run = {
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    }
    runFindFirst.mockResolvedValue(run)
    const caller = testRouter.createCaller(context())
    const preview = await caller.operations.getIntakeVenuePackageCandidate({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    const draftKey = intakeCandidateDraftKey({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
      candidateHash: preview.candidateHash!,
      actorId: 'platform-admin',
    })
    runFindFirst.mockResolvedValue({
      ...run,
      packageHandoff: { packageDraftId: 'package-1' },
    })
    handoffFindFirst.mockResolvedValue({
      createdBy: 'platform-admin',
      packageDraft: {
        id: 'package-1',
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        draftKey,
        payloadHash: preview.candidateHash,
        status: 'DRAFT',
        createdBy: 'platform-admin',
      },
    })
    reviewedDraft.orchestrate.mockResolvedValue({ value: { id: 'package-1' }, attachment: {} })
    await caller.operations.createAndLinkIntakeCandidateDraft({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
      expectedCandidateHash: preview.candidateHash!,
    })
    expect(reviewedDraft.orchestrate).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ draftKey }) }),
    )
  })

  it('rejects browser-supplied candidate payload or draft identity fields', async () => {
    await expect(
      testRouter.createCaller(context()).operations.createAndLinkIntakeCandidateDraft({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-1',
        draftKey: '11111111-1111-4111-8111-111111111111',
        expectedCandidateHash: 'a'.repeat(64),
        payload: { schemaVersion: 3 },
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(runFindFirst).not.toHaveBeenCalled()
    expect(reviewedDraft.orchestrate).not.toHaveBeenCalled()
  })

  it('revalidates candidate readiness inside the final transaction before linking', async () => {
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: null,
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    reviewedDraft.orchestrate.mockResolvedValue({ value: { id: 'package-1' }, attachment: {} })
    const caller = testRouter.createCaller(context())
    const candidate = await caller.operations.getIntakeVenuePackageCandidate({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
    })
    await caller.operations.createAndLinkIntakeCandidateDraft({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-1',
      expectedCandidateHash: candidate.candidateHash!,
    })
    const finalizer = reviewedDraft.orchestrate.mock.calls.at(-1)?.[0].finalizer
    runFindFirst.mockResolvedValue({
      id: 'run-1',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      packageHandoff: { packageDraftId: 'racing-draft' },
      ...candidateEvidence,
      structuredBootstrap: {
        version: 1,
        content: {
          kind: 'knowledge',
          value: { title: 'Hours', category: 'VISIT', content: 'Open daily.' },
        },
      },
    })
    await expect(finalizer({ tx: db } as never)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(eventCreate).not.toHaveBeenCalled()
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
          NOT: {
            structuredBootstrap: { path: ['kind'], equals: 'OPTIONAL_NOTES' },
          },
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
