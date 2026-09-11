import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveEvidence: vi.fn(),
  resolveAuthoringState: vi.fn(),
  createUniversalDraft: vi.fn(),
  adoptionFind: vi.fn(),
  atomicAdoptionFind: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  createOperationalUpdateAction: vi.fn(),
}))
vi.mock('../../lib/legacy-knowledge-adoption-service', () => ({
  createLegacyKnowledgeAdoptionDraftService: vi.fn(),
}))
vi.mock('../../lib/legacy-knowledge-adoption-preparation', () => ({
  LegacyKnowledgeAdoptionPreparationInput: { parse: vi.fn() },
  prepareLegacyKnowledgeAdoptionDraftService: vi.fn(),
}))
vi.mock('../../lib/semantic-venue-update-finalizer', () => ({
  semanticVenueUpdateDraftFinalizer: vi.fn(),
}))
vi.mock('../../lib/semantic-universal-content-handoff-service', () => ({
  createSemanticUniversalContentDraftService: mocks.createUniversalDraft,
}))
vi.mock('../../lib/semantic-operational-update-finalizer', () => ({
  semanticOperationalUpdateDraftFinalizer: vi.fn(),
}))
vi.mock('../../lib/support-proposal-authoring-state', () => ({
  resolveSupportProposalAuthoringState: mocks.resolveAuthoringState,
}))
vi.mock('../../lib/support-proposal-content-evidence', () => ({
  resolveSupportProposalContentEvidence: mocks.resolveEvidence,
}))
vi.mock('../../lib/semantic-venue-updater-service', () => ({
  previewSemanticVenueUpdateFromProposal: vi.fn(),
  semanticVenueUpdateDraftKey: vi.fn(),
  semanticVenueOperationalUpdateId: vi.fn(),
  SemanticVenueUpdaterError: class SemanticVenueUpdaterError extends Error {},
}))
vi.mock('../venue-package', () => ({ createVenuePackageDraftService: vi.fn() }))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminKnowledgeProposalDraftRouter } from './knowledge-proposal-drafts'

const app = router({ admin: adminKnowledgeProposalDraftRouter })
const input = {
  tenantId: 'tenant-support',
  venueId: 'venue-support',
  proposalId: '00000000-0000-4000-8000-000000000001',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  relation: 'NEW_FACT' as const,
  desired: {
    title: 'Quiet room',
    category: 'ACCESS',
    content: 'The quiet room is beside the east gallery.',
    isEnabled: true,
  },
  draft: {
    audience: 'PUBLIC' as const,
    evidence: [],
    payload: {
      kind: 'POLICY' as const,
      title: 'Quiet room',
      rule: 'The quiet room is beside the east gallery.',
      appliesTo: [],
    },
  },
}

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {
      marker: 'context-db',
      legacyKnowledgeUniversalContentAdoption: { findFirst: mocks.adoptionFind },
    } as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin-support',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

const atomicDb = {
  marker: 'atomic-db',
  legacyKnowledgeUniversalContentAdoption: { findFirst: mocks.atomicAdoptionFind },
}

describe('createSupportSemanticUniversalContentDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.adoptionFind.mockResolvedValue(null)
    mocks.atomicAdoptionFind.mockResolvedValue(null)
  })

  it('derives retained support evidence and delegates the exact scope and actor', async () => {
    const evidence = [
      {
        sourceId: 'support-message:message-1',
        locator: 'support-request:request-1',
        capturedAt: '2026-09-10T11:00:00.000Z',
        excerptHash: 'b'.repeat(64),
      },
    ]
    mocks.resolveEvidence.mockResolvedValueOnce(evidence)
    mocks.createUniversalDraft.mockImplementationOnce(async (params) => {
      await params.atomicPrecondition(atomicDb)
      return {
        moduleId: 'module-1',
        revisionId: 'revision-1',
        version: 1,
        classification: 'ADDITION',
        draftHash: 'c'.repeat(64),
        replayed: false,
      }
    })

    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft(input),
    ).resolves.toEqual({
      moduleId: 'module-1',
      revisionId: 'revision-1',
      version: 1,
      classification: 'ADDITION',
      draftHash: 'c'.repeat(64),
      replayed: false,
      requiresExplicitPublication: true,
      autoPublished: false,
    })
    expect(mocks.resolveEvidence).toHaveBeenCalledWith({
      db: expect.objectContaining({ marker: 'context-db' }),
      tenantId: input.tenantId,
      venueId: input.venueId,
      proposalId: input.proposalId,
    })
    expect(mocks.adoptionFind).toHaveBeenCalledWith({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
      },
      select: { id: true },
    })
    expect(mocks.atomicAdoptionFind).toHaveBeenCalledWith({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
      },
      select: { id: true },
    })
    expect(mocks.createUniversalDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        db: expect.objectContaining({ marker: 'context-db' }),
        actorId: 'admin-support',
        atomicPrecondition: expect.any(Function),
        input: { ...input, draft: { ...input.draft, evidence } },
      }),
    )
  })

  it('rejects caller-injected source evidence before resolving support provenance', async () => {
    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft({
        ...input,
        draft: {
          ...input.draft,
          evidence: [{ sourceId: 'forged', capturedAt: input.expectedProposalUpdatedAt }],
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.resolveEvidence).not.toHaveBeenCalled()
  })

  it('rejects payload wording that differs from the approved desired change', async () => {
    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft({
        ...input,
        draft: { ...input.draft, payload: { ...input.draft.payload, rule: 'Different wording.' } },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.resolveEvidence).not.toHaveBeenCalled()
  })

  it('rejects disabled and relationship drafts before resolving provenance', async () => {
    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft({
        ...input,
        desired: { ...input.desired, isEnabled: false },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft({
        ...input,
        draft: {
          ...input.draft,
          payload: {
            kind: 'RELATIONSHIP',
            fromModuleId: 'module-a',
            toModuleId: 'module-b',
            relationshipType: 'related-to',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.resolveEvidence).not.toHaveBeenCalled()
  })

  it('propagates missing retained support evidence without creating a draft', async () => {
    mocks.resolveEvidence.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Support evidence missing.' }),
    )

    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft(input),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.createUniversalDraft).not.toHaveBeenCalled()
  })

  it('keeps a proposal that already owns an adoption receipt on its adoption route', async () => {
    mocks.adoptionFind.mockResolvedValueOnce({ id: 'adoption-1' })

    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft(input),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.resolveEvidence).not.toHaveBeenCalled()
    expect(mocks.createUniversalDraft).not.toHaveBeenCalled()
  })

  it('rejects an adoption receipt that appears after the outer read and before revision creation', async () => {
    mocks.resolveEvidence.mockResolvedValueOnce([])
    let revisionCreated = false
    mocks.atomicAdoptionFind.mockResolvedValueOnce({ id: 'adoption-appeared' })
    mocks.createUniversalDraft.mockImplementationOnce(async (params) => {
      await params.atomicPrecondition(atomicDb)
      revisionCreated = true
      return {
        moduleId: 'module-1',
        revisionId: 'revision-1',
        version: 1,
        classification: 'ADDITION',
        draftHash: 'c'.repeat(64),
        replayed: false,
      }
    })

    await expect(
      app.createCaller(context()).admin.createSupportSemanticUniversalContentDraft(input),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(revisionCreated).toBe(false)
  })

  it('requires an authenticated platform administrator', async () => {
    await expect(
      app.createCaller(context(false)).admin.createSupportSemanticUniversalContentDraft(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.resolveEvidence).not.toHaveBeenCalled()
  })
})

describe('getSupportProposalAuthoringState', () => {
  it('passes only the exact scoped proposal and version to the read-only resolver', async () => {
    const stateInput = {
      tenantId: input.tenantId,
      venueId: input.venueId,
      proposalId: input.proposalId,
      expectedUpdatedAt: new Date(input.expectedProposalUpdatedAt),
    }
    mocks.resolveAuthoringState.mockResolvedValueOnce({ state: 'NO_TARGET' })
    await expect(
      app.createCaller(context()).admin.getSupportProposalAuthoringState(stateInput),
    ).resolves.toEqual({ state: 'NO_TARGET' })
    expect(mocks.resolveAuthoringState).toHaveBeenCalledWith({
      db: expect.objectContaining({ marker: 'context-db' }),
      input: stateInput,
    })
  })

  it('denies a non-admin before reading authoring state', async () => {
    mocks.resolveAuthoringState.mockClear()
    await expect(
      app.createCaller(context(false)).admin.getSupportProposalAuthoringState({
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: new Date(input.expectedProposalUpdatedAt),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.resolveAuthoringState).not.toHaveBeenCalled()
  })
})
