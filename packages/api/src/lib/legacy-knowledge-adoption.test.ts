import { describe, expect, it } from 'vitest'

import {
  legacyKnowledgeAdoptionDraftHash,
  legacyKnowledgeAdoptionModuleId,
  legacyKnowledgeSnapshotHash,
} from './legacy-knowledge-adoption'

const snapshot = {
  id: 'legacy-1',
  title: 'Capacity',
  category: 'admission',
  content: 'Capacity was recorded as 120.',
  isEnabled: true,
  visibility: 'PUBLIC',
  sourceType: 'PATHFINDER_INTAKE',
  authorship: 'HUMAN_AUTHORED',
  sourceName: 'Opening workbook',
  sourceUrl: null,
  importedAt: '2026-01-01T00:00:00.000Z',
  humanConfirmedAt: '2026-01-02T00:00:00.000Z',
  humanConfirmedBy: 'owner-1',
  lastReviewedAt: null,
  lastReviewedBy: null,
  sourcePackageId: 'package-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
}

describe('legacy knowledge adoption identities', () => {
  it('binds module identity to exact scope, row, and immutable snapshot', () => {
    const snapshotHash = legacyKnowledgeSnapshotHash(snapshot)
    const input = {
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      legacyKnowledgeEntryId: snapshot.id,
      legacySnapshotHash: snapshotHash,
    }
    expect(legacyKnowledgeAdoptionModuleId(input)).toBe(legacyKnowledgeAdoptionModuleId(input))
    expect(legacyKnowledgeAdoptionModuleId({ ...input, venueId: 'venue-2' })).not.toBe(
      legacyKnowledgeAdoptionModuleId(input),
    )
    expect(
      legacyKnowledgeAdoptionModuleId({ ...input, legacySnapshotHash: 'a'.repeat(64) }),
    ).not.toBe(legacyKnowledgeAdoptionModuleId(input))
    expect(
      legacyKnowledgeAdoptionModuleId({
        ...input,
        tenantId: 'tenant:one',
        venueId: 'venue',
      }),
    ).not.toBe(
      legacyKnowledgeAdoptionModuleId({
        ...input,
        tenantId: 'tenant',
        venueId: 'one:venue',
      }),
    )
  })

  it('binds replay to the approved preview, source snapshot, and complete typed draft', () => {
    const common = {
      proposalId: '11111111-1111-4111-8111-111111111111',
      previewHash: 'b'.repeat(64),
      legacySnapshotHash: legacyKnowledgeSnapshotHash(snapshot),
      draft: {
        audience: 'PUBLIC' as const,
        evidence: [],
        payload: {
          kind: 'POLICY' as const,
          title: snapshot.title,
          rule: snapshot.content,
          appliesTo: [],
        },
      },
    }
    expect(legacyKnowledgeAdoptionDraftHash(common)).toBe(legacyKnowledgeAdoptionDraftHash(common))
    expect(
      legacyKnowledgeAdoptionDraftHash({
        ...common,
        draft: { ...common.draft, payload: { ...common.draft.payload, rule: 'Changed.' } },
      }),
    ).not.toBe(legacyKnowledgeAdoptionDraftHash(common))
  })
})
