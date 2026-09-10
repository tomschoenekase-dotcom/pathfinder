import { describe, expect, it, vi } from 'vitest'

import { resolveSupportProposalAuthoringState } from './support-proposal-authoring-state'

const input = {
  tenantId: 'tenant-state',
  venueId: 'venue-state',
  proposalId: '00000000-0000-4000-8000-000000000001',
  expectedUpdatedAt: new Date('2026-09-10T12:00:00.000Z'),
}

function module() {
  return {
    kind: 'POLICY',
    revisions: [{ id: 'revision-1', version: 1 }],
    publications: [{ id: 'publication-1', revisionId: 'revision-1', action: 'PUBLISH' as const }],
  }
}

function dbWith(overrides: Record<string, unknown> = {}) {
  return {
    knowledgeChangeProposal: {
      findFirst: vi.fn().mockResolvedValue({
        status: 'APPROVED',
        updatedAt: input.expectedUpdatedAt,
        targetKnowledgeEntryId: 'target-1',
      }),
    },
    knowledgeProposalUniversalContentHandoff: { findFirst: vi.fn().mockResolvedValue(null) },
    venueKnowledgeEntry: {
      findFirst: vi.fn().mockResolvedValue({
        contentModuleId: null,
        contentRevisionId: null,
        contentPublicationId: null,
        contentModule: null,
      }),
    },
    legacyKnowledgeUniversalContentAdoption: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  }
}

async function resolve(db: ReturnType<typeof dbWith>) {
  return resolveSupportProposalAuthoringState({ db: db as never, input })
}

describe('resolveSupportProposalAuthoringState', () => {
  it('returns an immutable duplicate receipt before any authoring path, without claiming fulfillment', async () => {
    const receiptCreatedAt = new Date('2026-09-10T11:00:00.000Z')
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'APPROVED',
          updatedAt: input.expectedUpdatedAt,
          targetKnowledgeEntryId: 'target-1',
          duplicateResolution: {
            id: 'duplicate-resolution-1',
            proposalUpdatedAt: input.expectedUpdatedAt,
            targetKnowledgeEntryId: 'target-duplicate',
            relation: 'CORRECTS',
            createdAt: receiptCreatedAt,
          },
        }),
      },
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi.fn().mockResolvedValue({ moduleId: 'must-not-read' }),
      },
      knowledgeProposalUniversalContentHandoff: {
        findFirst: vi.fn().mockResolvedValue({ moduleId: 'must-not-read' }),
      },
    })

    await expect(resolve(db)).resolves.toEqual({
      state: 'OWN_DUPLICATE_RESOLUTION',
      resolutionId: 'duplicate-resolution-1',
      outcome: 'DUPLICATE_NOOP',
      targetKnowledgeEntryId: 'target-duplicate',
      relation: 'CORRECTS',
      createdAt: receiptCreatedAt,
      proposalRevisionCurrent: true,
      currentFulfillmentVerified: false,
    })
    expect(db.legacyKnowledgeUniversalContentAdoption.findFirst).not.toHaveBeenCalled()
    expect(db.knowledgeProposalUniversalContentHandoff.findFirst).not.toHaveBeenCalled()
    expect(db.venueKnowledgeEntry.findFirst).not.toHaveBeenCalled()
  })

  it('keeps a historical duplicate receipt terminal when its proposal revision is stale', async () => {
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'PUBLISHED',
          updatedAt: input.expectedUpdatedAt,
          targetKnowledgeEntryId: null,
          duplicateResolution: {
            id: 'duplicate-resolution-stale',
            proposalUpdatedAt: new Date('2026-09-10T11:59:59.000Z'),
            targetKnowledgeEntryId: 'target-duplicate',
            relation: 'SUPERSEDES',
            createdAt: new Date('2026-09-10T11:00:00.000Z'),
          },
        }),
      },
    })

    await expect(resolve(db)).resolves.toMatchObject({
      state: 'OWN_DUPLICATE_RESOLUTION',
      proposalRevisionCurrent: false,
      currentFulfillmentVerified: false,
    })
  })

  it('returns an own universal receipt before inspecting target state', async () => {
    const db = dbWith({
      knowledgeProposalUniversalContentHandoff: {
        findFirst: vi.fn().mockResolvedValue({
          moduleId: 'module-own',
          revisionId: 'revision-own',
          moduleKind: 'POLICY',
        }),
      },
    })

    await expect(resolve(db)).resolves.toMatchObject({
      state: 'OWN_UNIVERSAL_RECEIPT',
      moduleId: 'module-own',
      revisionId: 'revision-own',
      moduleKind: 'POLICY',
      latestRevision: null,
      latestPublication: null,
    })
    expect(db.venueKnowledgeEntry.findFirst).not.toHaveBeenCalled()
  })

  it('reports an untargeted proposal without granting authoring permission', async () => {
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'PENDING_REVIEW',
          updatedAt: input.expectedUpdatedAt,
          targetKnowledgeEntryId: null,
        }),
      },
    })

    await expect(resolve(db)).resolves.toEqual({
      state: 'NO_TARGET',
      proposalStatus: 'PENDING_REVIEW',
    })
  })

  it('keeps an own adoption receipt authoritative even after activation', async () => {
    const db = dbWith({
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi.fn().mockResolvedValue({
          proposalId: input.proposalId,
          moduleId: 'adoption-module',
          revisionId: 'adoption-revision',
          moduleKind: 'POLICY',
          activation: { publicationId: 'adoption-publication', revisionId: 'adoption-revision' },
          module: module(),
        }),
      },
    })

    await expect(resolve(db)).resolves.toMatchObject({
      state: 'OWN_ADOPTION_RECEIPT',
      moduleId: 'adoption-module',
      revisionId: 'adoption-revision',
      moduleKind: 'POLICY',
      activationPublicationId: 'adoption-publication',
      latestRevision: { id: 'revision-1', version: 1 },
      latestPublication: { id: 'publication-1', revisionId: 'revision-1', action: 'PUBLISH' },
    })
  })

  it('keeps an own adoption receipt ahead of universal receipts and changed target state', async () => {
    const db = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'APPROVED',
          updatedAt: input.expectedUpdatedAt,
          targetKnowledgeEntryId: null,
        }),
      },
      knowledgeProposalUniversalContentHandoff: {
        findFirst: vi.fn().mockResolvedValue({
          moduleId: 'universal-module',
          revisionId: 'universal-revision',
          moduleKind: 'POLICY',
          module: module(),
        }),
      },
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi.fn().mockResolvedValue({
          proposalId: input.proposalId,
          moduleId: 'adoption-module',
          revisionId: 'adoption-revision',
          moduleKind: 'POLICY',
          activation: { publicationId: 'adoption-publication' },
          module: {
            ...module(),
            publications: [
              { id: 'withdrawn', revisionId: 'adoption-revision', action: 'WITHDRAW' },
            ],
          },
        }),
      },
    })

    await expect(resolve(db)).resolves.toMatchObject({
      state: 'OWN_ADOPTION_RECEIPT',
      moduleId: 'adoption-module',
      revisionId: 'adoption-revision',
      latestPublication: { id: 'withdrawn', action: 'WITHDRAW' },
    })
    expect(db.knowledgeProposalUniversalContentHandoff.findFirst).not.toHaveBeenCalled()
  })

  it("blocks another proposal's pending adoption draft", async () => {
    const db = dbWith({
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({
          proposalId: '00000000-0000-4000-8000-000000000002',
          moduleId: 'module-other',
          revisionId: 'revision-other',
          moduleKind: 'POLICY',
          activation: null,
          module: module(),
        }),
      },
    })

    await expect(resolve(db)).resolves.toEqual({ state: 'OTHER_ADOPTION_DRAFT' })
  })

  it('uses an activated adoption as the native fallback only when its latest publication is exact', async () => {
    const db = dbWith({
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            proposalId: '00000000-0000-4000-8000-000000000002',
            moduleId: 'module-1',
            revisionId: 'revision-1',
            moduleKind: 'POLICY',
            activation: { publicationId: 'publication-1', revisionId: 'revision-1' },
            module: module(),
          }),
      },
    })

    await expect(resolve(db)).resolves.toEqual({
      state: 'NATIVE_READY',
      moduleId: 'module-1',
      moduleKind: 'POLICY',
      expectedBaseRevisionId: 'revision-1',
      expectedBaseVersion: 1,
      publicationId: 'publication-1',
    })
  })

  it('returns a direct native target only with exact latest published base links', async () => {
    const db = dbWith({
      venueKnowledgeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          contentModuleId: 'module-1',
          contentRevisionId: 'revision-1',
          contentPublicationId: 'publication-1',
          contentModule: module(),
        }),
      },
    })

    await expect(resolve(db)).resolves.toMatchObject({
      state: 'NATIVE_READY',
      moduleId: 'module-1',
      moduleKind: 'POLICY',
      expectedBaseRevisionId: 'revision-1',
      expectedBaseVersion: 1,
    })
  })

  it('fails closed for partial direct links and withdrawn or newer private native state', async () => {
    const partial = dbWith({
      venueKnowledgeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          contentModuleId: 'module-1',
          contentRevisionId: null,
          contentPublicationId: null,
          contentModule: module(),
        }),
      },
    })
    await expect(resolve(partial)).resolves.toEqual({
      state: 'NATIVE_NOT_READY',
      reason: 'PARTIAL_NATIVE_LINK',
    })

    const withdrawn = dbWith({
      venueKnowledgeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          contentModuleId: 'module-1',
          contentRevisionId: 'revision-1',
          contentPublicationId: 'publication-1',
          contentModule: {
            ...module(),
            publications: [{ id: 'publication-1', revisionId: 'revision-1', action: 'WITHDRAW' }],
          },
        }),
      },
    })
    await expect(resolve(withdrawn)).resolves.toEqual({
      state: 'NATIVE_NOT_READY',
      reason: 'UNPUBLISHED_OR_STALE_NATIVE',
    })
  })

  it('fails closed when direct and activated adoption identities disagree or either read is stale', async () => {
    const conflicting = dbWith({
      venueKnowledgeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          contentModuleId: 'direct-module',
          contentRevisionId: 'revision-1',
          contentPublicationId: 'publication-1',
          contentModule: module(),
        }),
      },
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            proposalId: '00000000-0000-4000-8000-000000000002',
            moduleId: 'adoption-module',
            revisionId: 'revision-1',
            moduleKind: 'POLICY',
            activation: { publicationId: 'publication-1', revisionId: 'revision-1' },
            module: module(),
          }),
      },
    })
    await expect(resolve(conflicting)).resolves.toEqual({
      state: 'NATIVE_NOT_READY',
      reason: 'CONFLICTING_NATIVE_IDENTITIES',
    })

    const staleDirect = dbWith({
      venueKnowledgeEntry: {
        findFirst: vi.fn().mockResolvedValue({
          contentModuleId: 'module-1',
          contentRevisionId: 'revision-1',
          contentPublicationId: 'publication-1',
          contentModule: { ...module(), revisions: [{ id: 'revision-2', version: 2 }] },
        }),
      },
      legacyKnowledgeUniversalContentAdoption: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            proposalId: '00000000-0000-4000-8000-000000000002',
            moduleId: 'module-1',
            revisionId: 'revision-1',
            moduleKind: 'POLICY',
            activation: { publicationId: 'publication-1', revisionId: 'revision-1' },
            module: module(),
          }),
      },
    })
    await expect(resolve(staleDirect)).resolves.toEqual({
      state: 'NATIVE_NOT_READY',
      reason: 'UNPUBLISHED_OR_STALE_NATIVE',
    })
  })

  it('reports missing targets and rejects stale or missing proposals in the exact scope', async () => {
    const missingTarget = dbWith({
      venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    await expect(resolve(missingTarget)).resolves.toEqual({
      state: 'NATIVE_NOT_READY',
      reason: 'TARGET_NOT_FOUND',
    })

    const stale = dbWith({
      knowledgeChangeProposal: {
        findFirst: vi.fn().mockResolvedValue({
          status: 'APPROVED',
          updatedAt: new Date('2026-09-10T12:00:01.000Z'),
          targetKnowledgeEntryId: null,
        }),
      },
    })
    await expect(resolve(stale)).rejects.toMatchObject({ code: 'CONFLICT' })

    const missing = dbWith({
      knowledgeChangeProposal: { findFirst: vi.fn().mockResolvedValue(null) },
    })
    await expect(resolve(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('uses tenant, venue, proposal, and target scopes for every receipt read', async () => {
    const db = dbWith()

    await resolve(db)

    expect(db.legacyKnowledgeUniversalContentAdoption.findFirst).toHaveBeenNthCalledWith(1, {
      where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
      select: expect.objectContaining({ moduleId: true, revisionId: true, moduleKind: true }),
    })
    expect(db.knowledgeProposalUniversalContentHandoff.findFirst).toHaveBeenCalledWith({
      where: { proposalId: input.proposalId, tenantId: input.tenantId, venueId: input.venueId },
      select: expect.objectContaining({ moduleId: true, revisionId: true, moduleKind: true }),
    })
    expect(db.legacyKnowledgeUniversalContentAdoption.findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: input.tenantId,
          venueId: input.venueId,
          legacyKnowledgeEntryId: 'target-1',
        }),
      }),
    )
  })
})
