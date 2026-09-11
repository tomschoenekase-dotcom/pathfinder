import { describe, expect, it } from 'vitest'

import { CreateSemanticUniversalContentDraftInput } from './universal-content-actions'

const base = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  expectedProposalUpdatedAt: '2026-09-07T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  relation: 'CORRECTS' as const,
}

describe('CreateSemanticUniversalContentDraftInput', () => {
  it('accepts an explicit typed draft while preserving separate publication authority', () => {
    expect(
      CreateSemanticUniversalContentDraftInput.parse({
        ...base,
        draft: {
          audience: 'PUBLIC',
          evidence: [
            {
              sourceId: 'knowledge-proposal:11111111-1111-4111-8111-111111111111',
              locator: 'approved-preview:'.concat('a'.repeat(64)),
              capturedAt: '2026-09-07T12:00:00.000Z',
              excerptHash: 'b'.repeat(64),
            },
          ],
          payload: {
            kind: 'POLICY',
            title: 'Photography policy',
            rule: 'Non-flash photography is allowed.',
            appliesTo: [],
          },
        },
      }),
    ).toMatchObject({ relation: 'CORRECTS', draft: { payload: { kind: 'POLICY' } } })
  })

  it('accepts an explicit relationship draft but still requires complete authority fences', () => {
    const relationship = CreateSemanticUniversalContentDraftInput.safeParse({
      ...base,
      draft: {
        audience: 'PUBLIC',
        evidence: [],
        payload: {
          kind: 'RELATIONSHIP',
          fromModuleId: 'module-a',
          toModuleId: 'module-b',
          relationshipType: 'RELATED_TO',
        },
      },
    })
    expect(relationship.success).toBe(true)
    expect(
      CreateSemanticUniversalContentDraftInput.safeParse({
        ...relationship.data,
        expectedPreviewHash: 'not-a-hash',
      }).success,
    ).toBe(false)
  })
})
