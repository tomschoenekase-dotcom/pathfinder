import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ preview: vi.fn() }))

vi.mock('./semantic-venue-updater-service', () => ({
  previewSemanticVenueUpdateFromProposal: mocks.preview,
}))

import { prepareLegacyKnowledgeAdoptionDraftService } from './legacy-knowledge-adoption-preparation'

const tenantId = 'tenant-preparation'
const venueId = 'venue-preparation'
const proposalId = '00000000-0000-4000-8000-000000000001'
const expectedUpdatedAt = new Date('2026-09-10T12:00:00.000Z')
const desired = {
  title: 'Updated hours',
  category: 'HOURS',
  content: 'Open from noon until ten.',
  isEnabled: true,
}

function legacyEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'legacy-entry',
    title: 'Hours',
    category: 'HOURS',
    content: 'Old hours.',
    isEnabled: true,
    visibility: 'PUBLIC',
    sourceType: 'UNKNOWN',
    authorship: 'UNKNOWN',
    sourceName: null,
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
    createdAt: new Date('2026-09-01T12:00:00.000Z'),
    updatedAt: new Date('2026-09-09T12:00:00.000Z'),
    ...overrides,
  }
}

function dbWith(entry: ReturnType<typeof legacyEntry> | null) {
  return {
    venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue(entry) },
  }
}

function input() {
  return {
    tenantId,
    venueId,
    proposalId,
    expectedUpdatedAt,
    relation: 'CORRECTS' as const,
    desired,
  }
}

describe('prepareLegacyKnowledgeAdoptionDraftService', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.preview.mockResolvedValue({
      proposalStatus: 'APPROVED',
      classification: 'CORRECTION',
      targetKnowledgeEntryId: 'legacy-entry',
      previewHash: 'a'.repeat(64),
    })
  })

  it('returns immutable adoption preconditions without creating a draft', async () => {
    const db = dbWith(legacyEntry())
    const scopedDb = db as never

    const result = await prepareLegacyKnowledgeAdoptionDraftService({
      db: scopedDb,
      input: input(),
    })

    expect(mocks.preview).toHaveBeenCalledWith({ db: scopedDb, ...input() })
    expect(db.venueKnowledgeEntry.findFirst).toHaveBeenCalledWith({
      where: { tenantId, venueId, id: 'legacy-entry' },
      select: expect.any(Object),
    })
    expect(result).toMatchObject({
      tenantId,
      venueId,
      proposalId,
      legacyKnowledgeEntryId: 'legacy-entry',
      expectedProposalUpdatedAt: expectedUpdatedAt.toISOString(),
      expectedPreviewHash: 'a'.repeat(64),
      expectedLegacyUpdatedAt: '2026-09-09T12:00:00.000Z',
      relation: 'CORRECTS',
      desired,
    })
    expect(result.expectedLegacySnapshotHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(result).not.toHaveProperty('draft')
  })

  it.each(['contentModuleId', 'contentRevisionId', 'contentPublicationId'] as const)(
    'rejects a native target linked by %s',
    async (field) => {
      const db = dbWith(legacyEntry({ [field]: 'native-link' }))

      await expect(
        prepareLegacyKnowledgeAdoptionDraftService({ db: db as never, input: input() }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<TRPCError>)
    },
  )

  it('rejects an unapproved preview', async () => {
    const db = dbWith(legacyEntry())
    mocks.preview.mockResolvedValueOnce({
      proposalStatus: 'PENDING_REVIEW',
      classification: 'CORRECTION',
      targetKnowledgeEntryId: 'legacy-entry',
      previewHash: 'a'.repeat(64),
    })

    await expect(
      prepareLegacyKnowledgeAdoptionDraftService({ db: db as never, input: input() }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<TRPCError>)
    expect(db.venueKnowledgeEntry.findFirst).not.toHaveBeenCalled()
  })

  it('rejects a missing scoped legacy target', async () => {
    const db = dbWith(null)

    await expect(
      prepareLegacyKnowledgeAdoptionDraftService({ db: db as never, input: input() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<TRPCError>)
  })

  it('rejects a preview with no target without loading a legacy row', async () => {
    const db = dbWith(legacyEntry())
    mocks.preview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      classification: 'ADDITION',
      targetKnowledgeEntryId: null,
      previewHash: 'a'.repeat(64),
    })

    await expect(
      prepareLegacyKnowledgeAdoptionDraftService({ db: db as never, input: input() }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<TRPCError>)
    expect(db.venueKnowledgeEntry.findFirst).not.toHaveBeenCalled()
  })

  it('propagates a stale semantic preview before loading a legacy row', async () => {
    const db = dbWith(legacyEntry())
    const stale = new Error('Knowledge proposal changed; reload its evidence.')
    mocks.preview.mockRejectedValueOnce(stale)

    await expect(
      prepareLegacyKnowledgeAdoptionDraftService({ db: db as never, input: input() }),
    ).rejects.toBe(stale)
    expect(db.venueKnowledgeEntry.findFirst).not.toHaveBeenCalled()
  })
})
