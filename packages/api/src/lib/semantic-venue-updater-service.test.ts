import { describe, expect, it, vi } from 'vitest'
import {
  hashSemanticConflictAnswer,
  hashSemanticConflictTarget,
} from './semantic-conflict-resolution-contract'

import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueConflictQuestionOperationId,
} from './semantic-venue-updater-service'

const updatedAt = new Date('2026-08-25T13:00:00.000Z')

function dbFixture(status: 'PENDING_REVIEW' | 'APPROVED' = 'APPROVED') {
  const proposal = {
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
  }
  const current = [
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
  ]
  const proposalFindFirst = vi.fn().mockResolvedValue(proposal)
  const entryFindMany = vi.fn().mockResolvedValue(current)
  return {
    db: {
      knowledgeChangeProposal: { findFirst: proposalFindFirst },
      venueKnowledgeEntry: { findMany: entryFindMany },
    } as never,
    proposalFindFirst,
    entryFindMany,
    proposal,
    current,
  }
}

describe('previewSemanticVenueUpdateFromProposal', () => {
  it('keeps the semantic conflict question operation identity stable and preview-specific', () => {
    const base = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: '11111111-1111-4111-8111-111111111111',
    }
    expect(semanticVenueConflictQuestionOperationId({ ...base, previewHash: 'c'.repeat(64) })).toBe(
      '864c1f4d-59b1-5c2d-8963-167c1d952166',
    )
    expect(
      semanticVenueConflictQuestionOperationId({ ...base, previewHash: 'd'.repeat(64) }),
    ).not.toBe('864c1f4d-59b1-5c2d-8963-167c1d952166')
  })

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

  it('retains all six change classes through the proposal/current-truth service boundary', async () => {
    const cases = [
      {
        expected: 'ADDITION',
        relation: 'NEW_FACT' as const,
        targetKnowledgeEntryId: null,
        current: [],
        desired: {
          title: 'Parking',
          category: 'ARRIVAL',
          content: 'Use the north lot.',
          isEnabled: true,
        },
        operationCount: 1,
      },
      {
        expected: 'SUPERSESSION',
        relation: 'SUPERSEDES' as const,
        targetKnowledgeEntryId: 'cm12345678901234567890123',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 9–5 daily.',
          isEnabled: true,
        },
        operationCount: 1,
      },
      {
        expected: 'TEMPORAL',
        relation: 'NEW_FACT' as const,
        targetKnowledgeEntryId: null,
        current: [],
        desired: {
          title: 'Holiday hours',
          category: 'HOURS',
          content: 'Open noon–4.',
          isEnabled: true,
        },
        validFrom: '2026-12-24T12:00:00.000Z',
        validUntil: '2026-12-24T22:00:00.000Z',
        operationalUpdateType: 'CHANGED_HOURS' as const,
        operationCount: 1,
      },
      {
        expected: 'DUPLICATE_NOOP',
        relation: 'CORRECTS' as const,
        targetKnowledgeEntryId: 'cm12345678901234567890123',
        desired: {
          title: 'Museum hours',
          category: 'HOURS',
          content: 'Open 10–5 daily.',
          isEnabled: true,
        },
        operationCount: 0,
      },
    ]

    for (const scenario of cases) {
      const fixture = dbFixture()
      fixture.proposalFindFirst.mockResolvedValue({
        ...fixture.proposal,
        targetKnowledgeEntryId: scenario.targetKnowledgeEntryId,
      })
      fixture.entryFindMany.mockResolvedValue(scenario.current ?? fixture.current)
      const input = {
        db: fixture.db,
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        proposalId: '11111111-1111-4111-8111-111111111111',
        expectedUpdatedAt: updatedAt,
        relation: scenario.relation,
        desired: scenario.desired,
        ...('validFrom' in scenario ? { validFrom: scenario.validFrom } : {}),
        ...('validUntil' in scenario ? { validUntil: scenario.validUntil } : {}),
        ...('operationalUpdateType' in scenario
          ? { operationalUpdateType: scenario.operationalUpdateType }
          : {}),
      }
      const first = await previewSemanticVenueUpdateFromProposal(input)
      const replayedPreview = await previewSemanticVenueUpdateFromProposal(input)

      expect(first).toMatchObject({
        classification: scenario.expected,
        operationCount: scenario.operationCount,
        autoApprove: false,
        autoApply: false,
        autoPublish: false,
      })
      expect(replayedPreview.previewHash).toBe(first.previewHash)
      if (scenario.expected === 'DUPLICATE_NOOP') {
        expect(first).toMatchObject({ requiresHumanReview: false, venuePackagePatch: null })
      } else {
        expect(first.requiresHumanReview).toBe(true)
      }
    }

    // CORRECTION and CONFLICT are exercised above and below with exact scoped assertions.
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

describe('explicit operator resolution preview fence', () => {
  function resolvedFixture() {
    const fixture = dbFixture()
    const target = {
      ...fixture.current[0]!,
      humanConfirmedAt: updatedAt,
      authorship: 'HUMAN_AUTHORED',
    }
    const desired = {
      title: target.title,
      category: target.category,
      content: 'Operator chosen hours',
      isEnabled: true,
    }
    const resolution = {
      id: '22222222-2222-4222-8222-222222222222',
      inputHash: 'a'.repeat(64),
      createdBy: 'operator-a',
      outcome: 'PROPOSE_REPLACEMENT',
      relation: 'CORRECTS',
      desired,
      targetKnowledgeEntryId: target.id,
      targetSnapshotHash: hashSemanticConflictTarget(target),
      answerHash: hashSemanticConflictAnswer('Reviewed answer'),
      answeredAt: updatedAt,
      questionUpdatedAt: updatedAt,
      question: { status: 'ANSWERED', answer: 'Reviewed answer', answeredAt: updatedAt, updatedAt },
    }
    const proposal = {
      ...fixture.proposal,
      proposedChange: desired.content,
      createdById: 'operator-a',
      producedByConflictResolution: resolution,
    }
    fixture.proposalFindFirst.mockResolvedValue(proposal)
    fixture.entryFindMany.mockResolvedValue([target])
    const input = {
      db: fixture.db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: proposal.id,
      expectedUpdatedAt: updatedAt,
      relation: 'CORRECTS' as const,
      desired,
    }
    return { ...fixture, target, desired, resolution, proposal, input }
  }
  it('requires separate approval without inventing higher source authority', async () => {
    const f = resolvedFixture()
    await expect(previewSemanticVenueUpdateFromProposal(f.input)).resolves.toMatchObject({
      classification: 'CORRECTION',
      authority: 'TRUSTED_PARTNER',
      operatorResolutionId: f.resolution.id,
      autoPublish: false,
    })
    f.proposalFindFirst.mockResolvedValue({ ...f.proposal, status: 'PENDING_REVIEW' })
    await expect(previewSemanticVenueUpdateFromProposal(f.input)).resolves.toMatchObject({
      classification: 'CONFLICT',
      authority: 'UNVERIFIED',
      operatorResolutionId: null,
    })
  })
  it('rejects changed desired, relation, canonical truth, authority and answered evidence', async () => {
    for (const change of [
      'desired',
      'relation',
      'target',
      'authority',
      'answer',
      'answer-time',
      'replacement-target',
      'replacement-text',
      'replacement-creator',
    ]) {
      const f = resolvedFixture()
      const input = { ...f.input }
      if (change === 'replacement-target') f.proposal.targetKnowledgeEntryId = 'other-target'
      if (change === 'replacement-text') f.proposal.proposedChange = 'Different reviewed text'
      if (change === 'replacement-creator') f.proposal.createdById = 'other-creator'
      if (change === 'desired') input.desired = { ...f.desired, content: 'Unreviewed edit' }
      if (change === 'relation') Object.assign(input, { relation: 'SUPERSEDES' })
      if (change === 'target')
        f.entryFindMany.mockResolvedValue([{ ...f.target, content: 'Changed current truth' }])
      if (change === 'authority')
        f.entryFindMany.mockResolvedValue([
          { ...f.target, humanConfirmedAt: new Date(updatedAt.getTime() + 1) },
        ])
      if (change === 'answer') f.resolution.question.answer = 'Different answer'
      if (change === 'answer-time')
        f.resolution.question.updatedAt = new Date(updatedAt.getTime() + 1)
      await expect(previewSemanticVenueUpdateFromProposal(input)).rejects.toMatchObject({
        code: 'NOT_REVIEWABLE',
      })
    }
  })
})
