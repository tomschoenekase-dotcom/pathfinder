import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createDraft: vi.fn(),
  prepareDraft: vi.fn(),
  resolveSupportEvidence: vi.fn(),
}))

vi.mock('../../lib/legacy-knowledge-adoption-service', () => ({
  createLegacyKnowledgeAdoptionDraftService: mocks.createDraft,
}))
vi.mock('../../lib/legacy-knowledge-adoption-preparation', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../lib/legacy-knowledge-adoption-preparation')>()
  return { ...original, prepareLegacyKnowledgeAdoptionDraftService: mocks.prepareDraft }
})
vi.mock('../../lib/support-proposal-content-evidence', () => ({
  resolveSupportProposalContentEvidence: mocks.resolveSupportEvidence,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminKnowledgeProposalDraftRouter } from './knowledge-proposal-drafts'

const testRouter = router({ admin: adminKnowledgeProposalDraftRouter })
const db = {} as TRPCContext['db']

function context(platformAdmin = true): TRPCContext {
  return {
    db,
    headers: new Headers(),
    session: {
      userId: 'platform_admin_1',
      activeTenantId: 'unrelated_active_tenant',
      role: 'STAFF',
      isPlatformAdmin: platformAdmin,
    },
  }
}

const input = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  legacyKnowledgeEntryId: 'legacy_entry_1',
  expectedProposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  expectedPreviewHash: 'a'.repeat(64),
  expectedLegacyUpdatedAt: '2026-09-10T11:00:00.000Z',
  expectedLegacySnapshotHash: 'b'.repeat(64),
  relation: 'CORRECTS' as const,
  desired: {
    title: 'Willow gallery hours',
    category: 'Hours',
    content: 'The Willow gallery closes at 6 PM.',
    isEnabled: true,
  },
  draft: {
    audience: 'PUBLIC' as const,
    evidence: [],
    payload: {
      kind: 'POLICY' as const,
      title: 'Willow gallery hours',
      rule: 'The Willow gallery closes at 6 PM.',
      appliesTo: [],
    },
  },
}

const preparationInput = {
  tenantId: input.tenantId,
  venueId: input.venueId,
  proposalId: input.proposalId,
  expectedUpdatedAt: new Date(input.expectedProposalUpdatedAt),
  relation: input.relation,
  desired: input.desired,
}

describe('admin legacy knowledge adoption draft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createDraft.mockResolvedValue({
      moduleId: '22222222-2222-4222-8222-222222222222',
      revisionId: '33333333-3333-4333-8333-333333333333',
      version: 1,
      draftHash: 'c'.repeat(64),
      legacySnapshotHash: 'd'.repeat(64),
      replayed: false,
      requiresExplicitPublication: true,
    })
    mocks.prepareDraft.mockResolvedValue({ tenantId: input.tenantId, venueId: input.venueId })
    mocks.resolveSupportEvidence.mockResolvedValue([
      {
        sourceId: 'support-message:message_1',
        locator: 'support-request:request_1',
        capturedAt: '2026-09-10T10:00:00.000Z',
        excerptHash: 'e'.repeat(64),
      },
    ])
  })

  it('gates and delegates the read-only adoption preparation query', async () => {
    await expect(
      testRouter
        .createCaller(context(false))
        .admin.prepareLegacyKnowledgeAdoptionDraft(preparationInput),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.prepareDraft).not.toHaveBeenCalled()

    await expect(
      testRouter
        .createCaller(context())
        .admin.prepareLegacyKnowledgeAdoptionDraft(preparationInput),
    ).resolves.toEqual({ tenantId: input.tenantId, venueId: input.venueId })
    expect(mocks.prepareDraft).toHaveBeenCalledWith({ db, input: preparationInput })
  })

  it('rejects non-platform-admin access before service delegation', async () => {
    await expect(
      testRouter.createCaller(context(false)).admin.createLegacyKnowledgeAdoptionDraft(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      testRouter
        .createCaller(context(false))
        .admin.createSupportLegacyKnowledgeAdoptionDraft(input),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.resolveSupportEvidence).not.toHaveBeenCalled()
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it('strictly validates the canonical service input before delegation', async () => {
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft({
        ...input,
        unexpectedPublicationRequest: true,
      } as unknown as typeof input),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft({
        ...input,
        expectedLegacySnapshotHash: 'not-a-hash',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft({
        ...input,
        draft: {
          ...input.draft,
          payload: { ...input.draft.payload, rule: 'Unrelated draft text.' },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft({
        ...input,
        draft: {
          ...input.draft,
          payload: {
            kind: 'RELATIONSHIP',
            fromModuleId: 'module-a',
            toModuleId: 'module-b',
            relationshipType: 'RELATED_TO',
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it('rejects disabled legacy guidance instead of losing its disabled state in a native draft', async () => {
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft({
        ...input,
        desired: { ...input.desired, isEnabled: false },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it('delegates exact scope and CAS input as the platform-admin human actor', async () => {
    const result = await testRouter
      .createCaller(context())
      .admin.createLegacyKnowledgeAdoptionDraft(input)

    expect(mocks.createDraft).toHaveBeenCalledOnce()
    expect(mocks.createDraft).toHaveBeenCalledWith({
      db,
      actor: { type: 'HUMAN', id: 'platform_admin_1', role: 'PLATFORM_ADMIN' },
      input,
    })
    expect(result).toEqual({
      moduleId: '22222222-2222-4222-8222-222222222222',
      revisionId: '33333333-3333-4333-8333-333333333333',
      version: 1,
      draftHash: 'c'.repeat(64),
      legacySnapshotHash: 'd'.repeat(64),
      replayed: false,
      requiresExplicitPublication: true,
      autoPublished: false,
    })
  })

  it('replaces empty caller evidence with exact scoped support evidence', async () => {
    const result = await testRouter
      .createCaller(context())
      .admin.createSupportLegacyKnowledgeAdoptionDraft(input)

    expect(mocks.resolveSupportEvidence).toHaveBeenCalledWith({
      db,
      tenantId: input.tenantId,
      venueId: input.venueId,
      proposalId: input.proposalId,
    })
    expect(mocks.createDraft).toHaveBeenCalledWith({
      db,
      actor: { type: 'HUMAN', id: 'platform_admin_1', role: 'PLATFORM_ADMIN' },
      input: {
        ...input,
        draft: {
          ...input.draft,
          evidence: [
            {
              sourceId: 'support-message:message_1',
              locator: 'support-request:request_1',
              capturedAt: '2026-09-10T10:00:00.000Z',
              excerptHash: 'e'.repeat(64),
            },
          ],
        },
      },
    })
    expect(result).toMatchObject({
      requiresExplicitPublication: true,
      autoPublished: false,
    })
  })

  it('rejects caller support evidence before resolver or service delegation', async () => {
    await expect(
      testRouter.createCaller(context()).admin.createSupportLegacyKnowledgeAdoptionDraft({
        ...input,
        draft: {
          ...input.draft,
          evidence: [
            {
              sourceId: 'caller-controlled',
              capturedAt: '2026-09-10T10:00:00.000Z',
              excerptHash: 'f'.repeat(64),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.resolveSupportEvidence).not.toHaveBeenCalled()
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it('propagates missing support provenance without creating a draft', async () => {
    mocks.resolveSupportEvidence.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Support request provenance not found.' }),
    )
    await expect(
      testRouter.createCaller(context()).admin.createSupportLegacyKnowledgeAdoptionDraft(input),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Support request provenance not found.',
    })
    expect(mocks.createDraft).not.toHaveBeenCalled()
  })

  it('propagates service conflicts without changing their meaning', async () => {
    mocks.createDraft.mockRejectedValueOnce(
      new TRPCError({ code: 'CONFLICT', message: 'Legacy knowledge source changed.' }),
    )
    await expect(
      testRouter.createCaller(context()).admin.createLegacyKnowledgeAdoptionDraft(input),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Legacy knowledge source changed.',
    })
  })
})
