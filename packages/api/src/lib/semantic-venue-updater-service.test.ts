import { describe, expect, it, vi } from 'vitest'

import { previewSemanticVenueUpdateFromProposal } from './semantic-venue-updater-service'

const updatedAt = new Date('2026-08-25T13:00:00.000Z')

function dbFixture(status: 'PENDING_REVIEW' | 'APPROVED' = 'APPROVED') {
  const proposalFindFirst = vi.fn().mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    status,
    targetKnowledgeEntryId: 'cm12345678901234567890123',
    proposedChange: 'Open 9–5 daily.',
    reason: 'Venue operator corrected the hours.',
    confidence: 0.95,
    evidenceMessageIds: ['message-a'],
    createdByType: 'HUMAN',
    createdAt: new Date('2026-08-25T12:00:00.000Z'),
    updatedAt,
  })
  const entryFindMany = vi.fn().mockResolvedValue([
    {
      id: 'cm12345678901234567890123',
      title: 'Museum hours',
      category: 'HOURS',
      content: 'Open 10–5 daily.',
      isEnabled: true,
      humanConfirmedAt: null,
      authorship: 'UNKNOWN',
      sourceType: 'UNKNOWN',
    },
  ])
  return {
    db: {
      knowledgeChangeProposal: { findFirst: proposalFindFirst },
      venueKnowledgeEntry: { findMany: entryFindMany },
    } as never,
    proposalFindFirst,
    entryFindMany,
  }
}

describe('previewSemanticVenueUpdateFromProposal', () => {
  it('scopes durable proposal/current truth and builds one approved correction patch', async () => {
    const fixture = dbFixture()
    const result = await previewSemanticVenueUpdateFromProposal({
      db: fixture.db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: '11111111-1111-4111-8111-111111111111',
      expectedUpdatedAt: updatedAt,
      relation: 'CORRECTS',
      desired: {
        title: 'Museum hours',
        category: 'HOURS',
        content: 'Open 9–5 daily.',
        isEnabled: true,
      },
    })

    expect(fixture.proposalFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: '11111111-1111-4111-8111-111111111111',
          tenantId: 'tenant-a',
          venueId: 'venue-a',
        }),
      }),
    )
    expect(fixture.entryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-a', venueId: 'venue-a' }),
      }),
    )
    expect(result).toMatchObject({
      classification: 'CORRECTION',
      operationCount: 1,
      proposalEvidenceRefs: ['guest-message:message-a'],
      autoApply: false,
      autoPublish: false,
    })
  })

  it('keeps an unapproved proposal blocked behind source authority', async () => {
    const fixture = dbFixture('PENDING_REVIEW')
    const result = await previewSemanticVenueUpdateFromProposal({
      db: fixture.db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: '11111111-1111-4111-8111-111111111111',
      expectedUpdatedAt: updatedAt,
      relation: 'CORRECTS',
      desired: {
        title: 'Museum hours',
        category: 'HOURS',
        content: 'Open 9–5 daily.',
        isEnabled: true,
      },
    })
    expect(result).toMatchObject({
      classification: 'CONFLICT',
      operationCount: 0,
      blockers: [expect.objectContaining({ code: 'EVIDENCE_REVIEW_REQUIRED' })],
    })
  })

  it('does not mistake platform review for venue confirmation', async () => {
    const fixture = dbFixture('APPROVED')
    fixture.entryFindMany.mockResolvedValueOnce([
      {
        id: 'cm12345678901234567890123',
        title: 'Museum hours',
        category: 'HOURS',
        content: 'Open 10–5 daily.',
        isEnabled: true,
        humanConfirmedAt: null,
        authorship: 'HUMAN_AUTHORED',
        sourceType: 'PATHFINDER_INTAKE',
      },
    ])
    const result = await previewSemanticVenueUpdateFromProposal({
      db: fixture.db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: '11111111-1111-4111-8111-111111111111',
      expectedUpdatedAt: updatedAt,
      relation: 'CORRECTS',
      desired: {
        title: 'Museum hours',
        category: 'HOURS',
        content: 'Open 9–5 daily.',
        isEnabled: true,
      },
    })
    expect(result).toMatchObject({
      authority: 'TRUSTED_PARTNER',
      classification: 'CONFLICT',
      blockers: [expect.objectContaining({ code: 'LOWER_AUTHORITY_CONFLICT' })],
    })
  })

  it('rejects stale proposal evidence before reading current knowledge', async () => {
    const fixture = dbFixture()
    await expect(
      previewSemanticVenueUpdateFromProposal({
        db: fixture.db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        proposalId: '11111111-1111-4111-8111-111111111111',
        expectedUpdatedAt: new Date('2026-08-25T14:00:00.000Z'),
        relation: 'CORRECTS',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 9–5 daily.',
          isEnabled: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE' })
    expect(fixture.entryFindMany).not.toHaveBeenCalled()
  })
})
