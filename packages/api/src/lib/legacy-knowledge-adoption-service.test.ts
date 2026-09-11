import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createUniversalContent: vi.fn(),
  preview: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  createUniversalContentAction: mocks.createUniversalContent,
  writeAuditLogStrict: mocks.audit,
}))

vi.mock('./semantic-venue-updater-service', () => ({
  previewSemanticVenueUpdateFromProposal: mocks.preview,
}))

import { legacyKnowledgeSnapshotHash } from './legacy-knowledge-adoption'
import {
  createLegacyKnowledgeAdoptionDraftService,
  legacyKnowledgeSnapshot,
} from './legacy-knowledge-adoption-service'

const proposalUpdatedAt = new Date('2026-09-10T12:00:00.000Z')
const legacyUpdatedAt = new Date('2026-09-10T11:00:00.000Z')
const previewHash = 'a'.repeat(64)
const legacy = {
  id: 'legacy-1',
  title: 'Gallery capacity',
  category: 'POLICY',
  content: 'The gallery capacity was 120.',
  isEnabled: true,
  visibility: 'PUBLIC',
  sourceType: 'UNKNOWN',
  authorship: 'UNKNOWN',
  sourceName: 'Opening workbook',
  sourceUrl: null,
  importedAt: null,
  humanConfirmedAt: null,
  humanConfirmedBy: null,
  lastReviewedAt: null,
  lastReviewedBy: null,
  sourcePackageId: null,
  contentModuleId: null,
  contentRevisionId: null,
  contentPublicationId: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: legacyUpdatedAt,
}
const expectedLegacySnapshotHash = legacyKnowledgeSnapshotHash(legacyKnowledgeSnapshot(legacy))
const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  legacyKnowledgeEntryId: legacy.id,
  expectedProposalUpdatedAt: proposalUpdatedAt.toISOString(),
  expectedPreviewHash: previewHash,
  expectedLegacyUpdatedAt: legacyUpdatedAt.toISOString(),
  expectedLegacySnapshotHash,
  relation: 'CORRECTS' as const,
  desired: {
    title: 'Gallery capacity',
    category: 'POLICY',
    content: 'The gallery capacity is 137.',
    isEnabled: true,
  },
  draft: {
    audience: 'PUBLIC' as const,
    evidence: [],
    payload: {
      kind: 'POLICY' as const,
      title: 'Gallery capacity',
      rule: 'The gallery capacity is 137.',
      appliesTo: [],
    },
  },
}

describe('createLegacyKnowledgeAdoptionDraftService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.preview.mockResolvedValue({
      previewHash,
      targetKnowledgeEntryId: legacy.id,
      classification: 'CORRECTION',
    })
  })

  it.each([
    ['contentModuleId', 'module-1'],
    ['contentRevisionId', 'revision-1'],
    ['contentPublicationId', 'publication-1'],
  ] as const)(
    'rejects a transactional %s native-link race before finalization',
    async (field, id) => {
      const venueKnowledgeFindFirst = vi
        .fn()
        .mockResolvedValueOnce(legacy)
        .mockResolvedValueOnce({ ...legacy, [field]: id })
      const db = {
        knowledgeChangeProposal: {
          findFirst: vi.fn().mockResolvedValue({
            status: 'APPROVED',
            updatedAt: proposalUpdatedAt,
            targetKnowledgeEntryId: legacy.id,
          }),
        },
        venueKnowledgeEntry: { findFirst: venueKnowledgeFindFirst },
        $queryRaw: vi.fn().mockResolvedValue([]),
      }
      let finalizerEntered = false
      mocks.createUniversalContent.mockImplementationOnce(
        async ({
          precondition,
          finalizer,
        }: {
          precondition: (tx: unknown) => Promise<void>
          finalizer: () => Promise<void>
        }) => {
          await precondition(db)
          finalizerEntered = true
          await finalizer()
        },
      )

      await expect(
        createLegacyKnowledgeAdoptionDraftService({
          db: db as never,
          actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
          input,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Legacy knowledge source changed.' })
      expect(venueKnowledgeFindFirst).toHaveBeenCalledTimes(2)
      expect(mocks.preview).toHaveBeenCalledTimes(1)
      expect(finalizerEntered).toBe(false)
      expect(mocks.audit).not.toHaveBeenCalled()
    },
  )
})
