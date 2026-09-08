import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('./knowledge-proposal-temporal-evidence', () => ({
  resolveKnowledgeProposalTemporalEvidence: mocks.resolve,
}))
import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const reference = {
  reviewReceiptId: '11111111-1111-4111-8111-111111111111',
  expectedSnapshotHash: 'a'.repeat(64),
  claimId: 'closure',
}
const evidence = {
  reference,
  claimHash: 'b'.repeat(64),
  reviewedBy: 'reviewer',
  reviewedAt: '2026-09-08T12:00:00.000Z',
  sourceRef: 'media-temporal-review:receipt:closure',
  targetKey: 'atrium:closure',
  targetItemHash: 'c'.repeat(64),
  authorityBasis: 'REVIEW_ASSERTED',
  authorityVerified: false,
}
const input = {
  tenantId: 'tenant',
  venueId: 'venue',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: new Date('2026-09-08T12:00:00.000Z'),
  relation: 'NEW_FACT' as const,
  desired: {
    title: 'Atrium closure',
    category: 'closure',
    content: 'Atrium closed.',
    isEnabled: true,
  },
  validFrom: '2030-01-01T00:00:00.000Z',
  validUntil: '2030-01-02T00:00:00.000Z',
  operationalUpdateType: 'TEMPORARY_CLOSURE' as const,
}
function fixture() {
  const proposal = {
    id: input.proposalId,
    status: 'APPROVED',
    conversationInsightId: 'insight',
    targetKnowledgeEntryId: null,
    proposedChange: input.desired.content,
    reason: 'Visitor report approved for drafting, not canonical publication.',
    confidence: 0.5,
    evidenceMessageIds: ['visitor-message'],
    createdByType: 'HUMAN',
    createdAt: input.expectedUpdatedAt,
    updatedAt: input.expectedUpdatedAt,
  }
  return {
    knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(proposal) },
    venueKnowledgeEntry: { findMany: vi.fn().mockResolvedValue([]) },
  }
}

describe('visitor closure semantic evidence connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(evidence)
  })
  it.each(['TEMPORARY_CLOSURE', 'UNAVAILABLE_EXHIBIT', 'GENERAL_NOTICE'] as const)(
    'does not bypass visitor evidence by labeling the dated draft %s',
    async (operationalUpdateType) => {
      const db = fixture()
      await expect(
        previewSemanticVenueUpdateFromProposal({
          db: db as never,
          ...input,
          operationalUpdateType,
        }),
      ).rejects.toMatchObject({ code: 'NOT_REVIEWABLE' })
      expect(mocks.resolve).not.toHaveBeenCalled()
      expect(db.venueKnowledgeEntry.findMany).not.toHaveBeenCalled()
    },
  )
  it('binds the exact reviewed source to the preview without verified authority or publication', async () => {
    const db = fixture()
    const result = await previewSemanticVenueUpdateFromProposal({
      db: db as never,
      ...input,
      temporalEvidence: reference,
    })
    expect(mocks.resolve).toHaveBeenCalledWith({
      db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      reference,
      desiredContent: input.desired.content,
      desiredTitle: input.desired.title,
      desiredCategory: input.desired.category,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
    })
    expect(result).toMatchObject({
      classification: 'TEMPORAL',
      authority: 'UNVERIFIED',
      temporalEvidence: evidence,
      proposalEvidenceRefs: ['guest-message:visitor-message'],
      autoPublish: false,
      operationalUpdateDraft: { status: 'DRAFT', autoSchedule: false, autoPublish: false },
    })
    mocks.resolve.mockResolvedValueOnce({ ...evidence, claimHash: 'd'.repeat(64) })
    const changed = await previewSemanticVenueUpdateFromProposal({
      db: db as never,
      ...input,
      temporalEvidence: reference,
    })
    expect(changed.previewHash).not.toBe(result.previewHash)
  })
  it('fails the preview when the source expires or does not match the requested target', async () => {
    mocks.resolve.mockRejectedValue(new Error('Reviewed source expired or mismatched.'))
    await expect(
      previewSemanticVenueUpdateFromProposal({
        db: fixture() as never,
        ...input,
        temporalEvidence: reference,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_REVIEWABLE',
      message: 'Reviewed source expired or mismatched.',
    })
  })
})
