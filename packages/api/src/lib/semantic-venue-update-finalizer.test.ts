import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({ writeAuditLogStrict: mocks.audit }))
vi.mock('./semantic-venue-updater-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./semantic-venue-updater-service')>()
  return { ...actual, previewSemanticVenueUpdateFromProposal: mocks.preview }
})

import { semanticVenueUpdateDraftFinalizer } from './semantic-venue-update-finalizer'
import { venuePackagePayloadHash } from './venue-package-identity'

const previewHash = 'a'.repeat(64)
const patch = {
  schemaVersion: 3 as const,
  places: { create: [], update: [], delete: [] },
  knowledgeEntries: {
    create: [
      {
        itemKey: '11111111-1111-4111-8111-111111111111',
        provenance: {
          sourceType: 'KNOWLEDGE_PROPOSAL',
          contentOrigin: 'HUMAN_AUTHORED' as const,
        },
        value: {
          title: 'Parking',
          category: 'ARRIVAL',
          content: 'Use the north lot.',
          isEnabled: true,
        },
      },
    ],
    update: [],
    delete: [],
  },
}
const previewInput = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '22222222-2222-4222-8222-222222222222',
  expectedUpdatedAt: new Date('2026-08-25T13:00:00.000Z'),
  relation: 'NEW_FACT' as const,
  desired: patch.knowledgeEntries.create[0]!.value,
}

function fixture(replay: unknown = null) {
  const findFirst = vi.fn().mockResolvedValue(replay)
  const create = vi.fn().mockResolvedValue({ id: 'handoff-a' })
  const tx = { knowledgeProposalPackageHandoff: { findFirst, create } }
  const input = {
    tx: tx as never,
    packageId: 'package-a',
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    status: 'DRAFT',
    createdBy: 'admin-a',
    preview: {
      payloadHash: venuePackagePayloadHash('venue-a', patch),
      report: { semanticDuplicateScan: { status: 'COMPLETE' } },
    } as never,
    replayed: false,
  }
  return { tx, findFirst, create, input }
}

describe('semantic venue update draft finalizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.audit.mockResolvedValue(undefined)
    mocks.preview.mockResolvedValue({
      proposalStatus: 'APPROVED',
      previewHash,
      venuePackagePatch: patch,
    })
  })

  it('atomically appends the exact proposal-to-package handoff', async () => {
    const { input, create } = fixture()
    const result = await semanticVenueUpdateDraftFinalizer({
      actorId: 'admin-a',
      expectedPreviewHash: previewHash,
      previewInput,
    })(input)

    expect(result).toEqual({ packageId: 'package-a', handoffId: 'handoff-a', replayed: false })
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalId: previewInput.proposalId,
        venuePackageId: 'package-a',
        previewHash,
      }),
      select: { id: true },
    })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'knowledge-proposal.semantic-package-draft-created-and-linked',
        afterState: expect.objectContaining({
          packageStatus: 'DRAFT',
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
        }),
      }),
      input.tx,
    )
  })

  it('reconciles an exact replay without requiring the original operator', async () => {
    const { input, create } = fixture({
      id: 'handoff-a',
      venuePackageId: 'package-a',
      previewHash,
    })
    const result = await semanticVenueUpdateDraftFinalizer({
      actorId: 'admin-b',
      expectedPreviewHash: previewHash,
      previewInput,
    })({ ...input, replayed: true, createdBy: 'admin-a' })
    expect(result).toEqual({ packageId: 'package-a', handoffId: 'handoff-a', replayed: true })
    expect(create).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('rolls back when the approved preview changes inside finalization', async () => {
    mocks.preview.mockResolvedValueOnce({
      proposalStatus: 'APPROVED',
      previewHash: 'b'.repeat(64),
      venuePackagePatch: patch,
    })
    const { input, create } = fixture()
    await expect(
      semanticVenueUpdateDraftFinalizer({
        actorId: 'admin-a',
        expectedPreviewHash: previewHash,
        previewInput,
      })(input),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(create).not.toHaveBeenCalled()
  })

  it('requires completed semantic duplicate evidence before attachment', async () => {
    const { input } = fixture()
    await expect(
      semanticVenueUpdateDraftFinalizer({
        actorId: 'admin-a',
        expectedPreviewHash: previewHash,
        previewInput,
      })({
        ...input,
        preview: { report: { semanticDuplicateScan: { status: 'INCOMPLETE' } } } as never,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.preview).not.toHaveBeenCalled()
  })
})
