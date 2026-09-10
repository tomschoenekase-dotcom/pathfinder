import { describe, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  audit: vi.fn(),
  evidence: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  lockVenueContentMutation: mocks.lock,
  writeAuditLogStrict: mocks.audit,
}))
vi.mock('./support-proposal-content-evidence', () => ({
  resolveSupportProposalContentEvidence: mocks.evidence,
}))

import { createSemanticReviewedDeclineService } from './semantic-reviewed-decline-service'

const input = {
  operationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  resolutionNote: 'Declined after reviewing the frozen source evidence.',
}
const before = new Date(input.expectedProposalUpdatedAt)
const after = new Date('2026-09-10T12:01:00.000Z')

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: input.proposalId,
    status: 'PENDING_REVIEW',
    updatedAt: before,
    supportRequestId: 'request-a',
    supportRequestVersion: 4,
    producedByConflictResolution: null,
    packageHandoff: null,
    operationalUpdateHandoff: null,
    universalContentHandoff: null,
    legacyContentAdoption: null,
    conflictResolutions: [],
    duplicateResolution: null,
    ...overrides,
  }
}

function harness(
  overrides: {
    proposal?: Record<string, unknown> | null
    existing?: unknown
    prior?: unknown
  } = {},
) {
  const tx = {
    semanticReviewedDecline: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(overrides.existing ?? null)
        .mockResolvedValueOnce(overrides.prior ?? null),
      create: vi.fn().mockResolvedValue({ id: input.operationId }),
    },
    knowledgeChangeProposal: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(
          overrides.proposal === null
            ? null
            : overrides.proposal
              ? proposal(overrides.proposal)
              : proposal(),
        )
        .mockResolvedValueOnce({ updatedAt: after }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  }
  const db = { $transaction: vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)) }
  return { tx, db }
}

async function call(db: unknown, actorId = 'admin-a', body = input) {
  return createSemanticReviewedDeclineService({ db: db as never, actorId, input: body })
}

describe('createSemanticReviewedDeclineService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.evidence.mockResolvedValue([{ sourceId: 'support-message:message-a' }])
  })

  it('records a source-bound pending review decline with no canonical effects', async () => {
    const { tx, db } = harness()
    await expect(call(db)).resolves.toEqual({
      resolutionId: input.operationId,
      outcome: 'REVIEWED_DECLINE',
      replayed: false,
      canonicalKnowledgeChanged: false,
      approvalGranted: false,
      completionGranted: false,
      currentFulfillmentVerified: false,
    })
    expect(mocks.lock).toHaveBeenCalledWith(tx, expect.objectContaining({ venueId: input.venueId }))
    expect(tx.knowledgeChangeProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING_REVIEW', updatedAt: before }),
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewerId: 'admin-a',
          reviewNote: input.resolutionNote,
        }),
      }),
    )
    expect(tx.semanticReviewedDecline.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceProposalId: input.proposalId,
          supportRequestId: 'request-a',
          supportRequestVersion: 4,
          proposalUpdatedAt: before,
          reviewedProposalUpdatedAt: after,
        }),
      }),
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        afterState: expect.objectContaining({ canonicalKnowledgeChanged: false }),
      }),
      tx,
    )
  })

  it('freshly re-attests an existing rejected proposal instead of trusting its old review markers', async () => {
    const { tx, db } = harness({ proposal: { status: 'REJECTED' } })
    await call(db)
    expect(tx.knowledgeChangeProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'REJECTED' }) }),
    )
    expect(tx.semanticReviewedDecline.create).toHaveBeenCalledTimes(1)
  })

  it('returns only an exact same-actor input replay before source or proposal work', async () => {
    const { tx, db } = harness({ existing: { id: input.operationId, inputHash: 'wrong' } })
    await expect(call(db)).rejects.toMatchObject({ code: 'CONFLICT' })
    const exact = await import('node:crypto').then(({ createHash }) =>
      createHash('sha256')
        .update(JSON.stringify({ ...input, actorId: 'admin-a' }))
        .digest('hex'),
    )
    tx.semanticReviewedDecline.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: input.operationId, inputHash: exact })
    await expect(call(db)).resolves.toMatchObject({ replayed: true })
    expect(mocks.evidence).not.toHaveBeenCalled()
    expect(tx.knowledgeChangeProposal.updateMany).not.toHaveBeenCalled()
  })

  it('denies missing scope, stale version, and non-reviewable status', async () => {
    const missing = harness({ proposal: null })
    await expect(call(missing.db)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(missing.tx.semanticReviewedDecline.create).not.toHaveBeenCalled()
    for (const item of [
      harness({ proposal: { updatedAt: after } }),
      harness({ proposal: { status: 'APPROVED' } }),
    ]) {
      await expect(call(item.db)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(item.tx.semanticReviewedDecline.create).not.toHaveBeenCalled()
    }
  })

  it('blocks every competing outcome before resolving source evidence', async () => {
    for (const competing of [
      { packageHandoff: { proposalId: input.proposalId } },
      { operationalUpdateHandoff: { id: 'handoff' } },
      { universalContentHandoff: { id: 'handoff' } },
      { legacyContentAdoption: { id: 'receipt' } },
      { conflictResolutions: [{ id: 'resolution' }] },
      { duplicateResolution: { id: 'resolution' } },
    ]) {
      const { tx, db } = harness({ proposal: competing })
      await expect(call(db)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(tx.semanticReviewedDecline.create).not.toHaveBeenCalled()
    }
    expect(mocks.evidence).not.toHaveBeenCalled()
  })

  it('freezes a one-hop replacement source and fails before mutation when evidence fails', async () => {
    const original = {
      id: '33333333-3333-4333-8333-333333333333',
      supportRequestId: 'request-original',
      supportRequestVersion: 2,
      producedByConflictResolution: null,
    }
    const good = harness({
      proposal: {
        supportRequestId: null,
        supportRequestVersion: null,
        producedByConflictResolution: { proposalId: original.id, proposal: original },
      },
    })
    await call(good.db)
    expect(good.tx.semanticReviewedDecline.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceProposalId: original.id, supportRequestVersion: 2 }),
      }),
    )

    const bad = harness()
    mocks.evidence.mockRejectedValueOnce(new Error('source missing'))
    await expect(call(bad.db)).rejects.toThrow('source missing')
    expect(bad.tx.knowledgeChangeProposal.updateMany).not.toHaveBeenCalled()
    expect(bad.tx.semanticReviewedDecline.create).not.toHaveBeenCalled()
  })

  it('rejects a prior immutable receipt and uniqueness collision without effects', async () => {
    const prior = harness({ prior: { id: 'prior' } })
    await expect(call(prior.db)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(prior.tx.knowledgeChangeProposal.updateMany).not.toHaveBeenCalled()

    const unique = harness()
    unique.tx.semanticReviewedDecline.create.mockRejectedValue({ code: 'P2002' })
    await expect(call(unique.db)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
