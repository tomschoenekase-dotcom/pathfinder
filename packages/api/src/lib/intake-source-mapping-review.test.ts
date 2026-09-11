import { describe, expect, it, vi } from 'vitest'

import {
  reviewIntakeSourceMappingForV1,
  type IntakeSourceMappingReviewDependencies,
} from './intake-source-mapping-review'

const scope = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceRunId: 'source-a',
  expectedSourceInputHash: 'a'.repeat(64),
  reviewedBy: 'reviewer-a',
  rationale: 'This exact evidence is suitable for a review-only proposal.',
}

function dependencies(source: Record<string, unknown>, websiteResult?: Record<string, unknown>) {
  const review = vi.fn(async (_input, projector) => {
    const projection = await projector({} as never, source as never)
    return { projection, replayed: false }
  })
  const buildWebsiteMapping = vi.fn().mockResolvedValue(websiteResult)
  return { review, buildWebsiteMapping } as unknown as IntakeSourceMappingReviewDependencies & {
    review: typeof review
    buildWebsiteMapping: typeof buildWebsiteMapping
  }
}

describe('V1 source mapping review service', () => {
  it('retains only explicit Unicode code-point ranges from human optional notes', async () => {
    const notes = 'A🙂B private'
    const deps = dependencies({
      id: scope.sourceRunId,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      requestedByType: 'HUMAN',
      structuredBootstrap: { kind: 'OPTIONAL_NOTES', notes },
      evidence: [
        {
          locator: `optional-notes:${scope.sourceRunId}`,
          normalizedHash: createHash('sha256').update(notes).digest('hex'),
        },
      ],
    })
    const result = await reviewIntakeSourceMappingForV1(
      {
        db: {} as never,
        command: {
          ...scope,
          kind: 'OPTIONAL_NOTES_SELECTION',
          consentToPublicUse: true,
          ranges: [{ start: 1, end: 3 }],
          title: 'Reviewed excerpt',
          category: 'VISITOR_INFO',
        },
      },
      deps,
    )
    const projection = (result as unknown as { projection: unknown }).projection as {
      payload: { knowledgeEntries: { create: Array<{ value: { content: string } }> } }
      selectionSnapshot: { ranges: Array<{ start: number; end: number }> }
    }
    expect(projection.payload.knowledgeEntries.create[0]?.value.content).toBe('🙂B')
    expect(projection.selectionSnapshot.ranges).toEqual([{ start: 1, end: 3 }])
  })

  it('rejects agent-owned notes and out-of-range selections before persistence projection returns', async () => {
    const notes = 'Human review only'
    const normalizedHash = createHash('sha256').update(notes).digest('hex')
    const source = {
      id: scope.sourceRunId,
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      requestedByType: 'AGENT',
      structuredBootstrap: { kind: 'OPTIONAL_NOTES', notes },
      evidence: [{ locator: `optional-notes:${scope.sourceRunId}`, normalizedHash }],
    }
    await expect(
      reviewIntakeSourceMappingForV1(
        {
          db: {} as never,
          command: {
            ...scope,
            kind: 'OPTIONAL_NOTES_SELECTION',
            consentToPublicUse: true,
            ranges: [{ start: 0, end: 5 }],
            title: 'Title',
            category: 'INFO',
          },
        },
        dependencies(source),
      ),
    ).rejects.toThrow('human-authored')
  })

  it('binds website projection to the exact retained receipt, research hash, and selections', async () => {
    const payload = {
      schemaVersion: 3 as const,
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: {
        create: [
          {
            itemKey: '22222222-2222-5222-8222-222222222222',
            provenance: {
              sourceType: 'PATHFINDER_INTAKE',
              contentOrigin: 'HUMAN_AUTHORED' as const,
            },
            value: { title: 'Hours', category: 'HOURS', content: 'Open daily', isEnabled: true },
          },
        ],
        update: [],
        delete: [],
      },
    }
    const deps = dependencies(
      { id: scope.sourceRunId, sourceKind: 'WEBSITE' },
      {
        receiptId: '33333333-3333-4333-8333-333333333333',
        researchHash: 'b'.repeat(64),
        mappingReviewHash: 'c'.repeat(64),
        selections: [{ fieldPath: 'venue.hours', evidenceId: 'evidence-a' }],
        clarificationEvidence: [],
        payload,
      },
    )
    const result = await reviewIntakeSourceMappingForV1(
      {
        db: {} as never,
        command: {
          ...scope,
          kind: 'WEBSITE_MAPPING',
          receiptId: '33333333-3333-4333-8333-333333333333',
          expectedResearchHash: 'b'.repeat(64),
          selections: [{ fieldPath: 'venue.hours', evidenceId: 'evidence-a' }],
        },
      },
      deps,
    )
    expect(deps.buildWebsiteMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: '33333333-3333-4333-8333-333333333333',
        expectedResearchHash: 'b'.repeat(64),
      }),
    )
    expect((result as unknown as { projection: unknown }).projection).toMatchObject({
      researchReceiptId: '33333333-3333-4333-8333-333333333333',
      researchHash: 'b'.repeat(64),
    })
  })
})
import { createHash } from 'node:crypto'
