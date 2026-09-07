import { describe, expect, it } from 'vitest'

import {
  semanticUniversalContentDraft,
  semanticUniversalContentDraftHash,
  semanticUniversalContentModuleId,
  planSemanticUniversalContentHandoff,
} from './semantic-universal-content-handoff'

const scope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  previewHash: 'a'.repeat(64),
}

describe('semantic universal-content handoff identity', () => {
  it('derives stable scoped module and draft identities', () => {
    const moduleId = semanticUniversalContentModuleId(scope)
    expect(semanticUniversalContentModuleId(scope)).toBe(moduleId)
    expect(semanticUniversalContentModuleId({ ...scope, venueId: 'venue-2' })).not.toBe(moduleId)
    expect(moduleId).toMatch(/^[a-f0-9-]{36}$/u)
  })

  it('retains original source evidence and adds the exact approved proposal preview once', () => {
    const draft = {
      audience: 'PUBLIC' as const,
      evidence: [
        {
          sourceId: 'official-policy.pdf',
          locator: 'page:4',
          capturedAt: '2026-09-01T12:00:00.000Z',
          excerptHash: 'b'.repeat(64),
        },
      ],
      payload: {
        kind: 'POLICY' as const,
        title: 'Photography policy',
        rule: 'Non-flash photography is allowed.',
        appliesTo: [],
      },
    }
    const enriched = semanticUniversalContentDraft({
      draft,
      proposalId: scope.proposalId,
      proposalUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
      previewHash: scope.previewHash,
    })
    expect(enriched.evidence).toHaveLength(2)
    expect(enriched.evidence).toContainEqual(draft.evidence[0])
    expect(
      semanticUniversalContentDraft({
        draft: enriched,
        proposalId: scope.proposalId,
        proposalUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
        previewHash: scope.previewHash,
      }).evidence,
    ).toHaveLength(2)

    const hash = semanticUniversalContentDraftHash({
      proposalId: scope.proposalId,
      previewHash: scope.previewHash,
      relation: 'CORRECTS',
      targetModuleId: moduleIdForTest,
      expectedBaseRevisionId: 'revision-1',
      expectedBaseVersion: 1,
      draft: enriched,
    })
    expect(hash).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('does not discard source evidence when the typed draft has no proposal slot', () => {
    expect(() =>
      semanticUniversalContentDraft({
        draft: {
          audience: 'PUBLIC',
          evidence: Array.from({ length: 100 }, (_, index) => ({
            sourceId: `source-${index}`,
            capturedAt: '2026-09-01T12:00:00.000Z',
          })),
          payload: {
            kind: 'OPERATIONAL_FACT',
            label: 'Capacity',
            value: '137',
          },
        },
        proposalId: scope.proposalId,
        proposalUpdatedAt: new Date('2026-09-07T12:00:00.000Z'),
        previewHash: scope.previewHash,
      }),
    ).toThrow('reserve one evidence slot')
  })

  it('plans only exact current typed targets and identifies legacy adoption', () => {
    const draft = {
      audience: 'PUBLIC' as const,
      evidence: [],
      payload: { kind: 'POLICY' as const, title: 'Tickets', rule: 'Keep tickets.', appliesTo: [] },
    }
    expect(
      planSemanticUniversalContentHandoff({
        classification: 'CORRECTION',
        relation: 'CORRECTS',
        draft,
        additionModuleId: moduleIdForTest,
        target: {
          knowledgeEntryId: 'entry-1',
          moduleId: moduleIdForTest,
          revisionId: 'revision-2',
          publicationId: 'publication-2',
          moduleKind: 'POLICY',
          latestVersion: 2,
          latestRevisionId: 'revision-2',
          latestPublicationId: 'publication-2',
          latestPublicationRevisionId: 'revision-2',
          latestPublicationAction: 'PUBLISH',
        },
      }),
    ).toEqual({
      action: 'APPEND',
      moduleId: moduleIdForTest,
      expectedBaseRevisionId: 'revision-2',
      expectedBaseVersion: 2,
    })
    expect(() =>
      planSemanticUniversalContentHandoff({
        classification: 'SUPERSESSION',
        relation: 'SUPERSEDES',
        draft,
        additionModuleId: moduleIdForTest,
        target: {
          knowledgeEntryId: 'legacy-1',
          moduleId: null,
          revisionId: null,
          publicationId: null,
          moduleKind: null,
          latestVersion: null,
          latestRevisionId: null,
          latestPublicationId: null,
          latestPublicationRevisionId: null,
          latestPublicationAction: null,
        },
      }),
    ).toThrow(/adopted into universal content/)
  })

  it('supports an explicit typed relationship addition without inferring endpoints', () => {
    expect(
      planSemanticUniversalContentHandoff({
        classification: 'ADDITION',
        relation: 'NEW_FACT',
        additionModuleId: moduleIdForTest,
        target: null,
        draft: {
          audience: 'PUBLIC',
          evidence: [],
          payload: {
            kind: 'RELATIONSHIP',
            fromModuleId: 'module-a',
            toModuleId: 'module-b',
            relationshipType: 'LOCATED_NEAR',
          },
        },
      }),
    ).toMatchObject({ action: 'CREATE', moduleId: moduleIdForTest })
  })
})

const moduleIdForTest = '22222222-2222-4222-8222-222222222222'
