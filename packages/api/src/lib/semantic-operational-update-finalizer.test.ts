import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ audit: vi.fn(), preview: vi.fn() }))

vi.mock('@pathfinder/db', () => ({ writeAuditLogStrict: mocks.audit }))
vi.mock('./semantic-venue-updater-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./semantic-venue-updater-service')>()
  return { ...actual, previewSemanticVenueUpdateFromProposal: mocks.preview }
})

import { semanticOperationalUpdateDraftFinalizer } from './semantic-operational-update-finalizer'

const previewHash = 'a'.repeat(64)
const previewInput = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
  relation: 'NEW_FACT' as const,
  desired: {
    title: 'Atrium closure',
    category: 'TEMPORARY_CLOSURE',
    content: 'Closed for maintenance.',
    isEnabled: true,
  },
  validFrom: '2030-01-01T08:00:00.000Z',
  validUntil: '2030-01-01T12:00:00.000Z',
  operationalUpdateType: 'TEMPORARY_CLOSURE' as const,
}
const draft = {
  updateType: 'TEMPORARY_CLOSURE',
  severity: 'INFO',
  priority: 'NORMAL',
  title: previewInput.desired.title,
  body: previewInput.desired.content,
  startsAt: previewInput.validFrom,
  expiresAt: previewInput.validUntil,
}

function fixture() {
  const create = vi.fn().mockResolvedValue({ id: 'handoff-a' })
  const tx = { knowledgeProposalOperationalUpdateHandoff: { create } }
  const update = {
    id: 'update-a',
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    placeId: null,
    ...draft,
    startsAt: new Date(draft.startsAt),
    expiresAt: new Date(draft.expiresAt),
    redirectTo: null,
    status: 'DRAFT',
    isActive: false,
    createdBy: 'admin-a',
    publishedBy: null,
    publishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return { tx, create, update }
}

describe('semantic operational update draft finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.audit.mockResolvedValue(undefined)
    mocks.preview.mockResolvedValue({
      proposalStatus: 'APPROVED',
      previewHash,
      operationalUpdateDraft: draft,
    })
  })

  it('atomically appends the exact proposal-to-update DRAFT handoff', async () => {
    const { tx, create, update } = fixture()
    await semanticOperationalUpdateDraftFinalizer({
      actorId: 'admin-a',
      expectedPreviewHash: previewHash,
      previewInput,
    })({ tx: tx as never, update: update as never, preview: {} as never })

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalId: previewInput.proposalId,
        operationalUpdateId: update.id,
        previewHash,
      }),
      select: { id: true },
    })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'knowledge-proposal.semantic-operational-update-draft-created-and-linked',
        afterState: expect.objectContaining({
          operationalUpdateStatus: 'DRAFT',
          autoScheduled: false,
          autoPublished: false,
        }),
      }),
      tx,
    )
  })

  it('rejects preview drift or a non-draft effect before linkage', async () => {
    const { tx, create, update } = fixture()
    mocks.preview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      operationalUpdateDraft: draft,
    })
    await expect(
      semanticOperationalUpdateDraftFinalizer({
        actorId: 'admin-a',
        expectedPreviewHash: previewHash,
        previewInput,
      })({
        tx: tx as never,
        update: { ...update, status: 'PUBLISHED' } as never,
        preview: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(create).not.toHaveBeenCalled()
  })
})
