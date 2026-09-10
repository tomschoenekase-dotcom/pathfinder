import { describe, expect, it, vi } from 'vitest'

import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'

const resolveNativeGuestReadSnapshot = vi.hoisted(() => vi.fn())

vi.mock('./native-guest-content-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./native-guest-content-read')>()
  return { ...actual, resolveNativeGuestReadSnapshotAction: resolveNativeGuestReadSnapshot }
})

import {
  readSupportContentFulfillment,
  supportContentFulfillmentDigest,
} from './support-content-fulfillment'

const scope = { tenantId: 'tenant_1', venueId: 'venue_1', supportRequestId: 'request_1' }
const asOf = new Date('2026-09-10T12:00:00.000Z')
const releaseId = '11111111-1111-4111-8111-111111111111'

function nativeState(content: string) {
  return {
    venue: {
      name: 'Venue',
      slug: 'venue',
      description: null,
      guideNotes: null,
      aiGuideNotes: null,
      aiFeaturedPlaceId: null,
      aiTone: null,
      tonePreset: null,
      tonePresetVersion: null,
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      category: null,
      guideMode: 'location_aware',
      defaultCenterLat: null,
      defaultCenterLng: null,
      geoBoundary: null,
      isActive: true,
    },
    venueBotConfiguration: {
      presentationMode: 'CLASSIC' as const,
      personalityMode: 'PRESET' as const,
      tonePreset: 'friendly' as const,
      tonePresetVersion: 1,
      responseDepth: 'BALANCED' as const,
      personalityProfileId: null,
      characterKey: null,
      customCharacterId: null,
      publicDisplayName: null,
      greeting: null,
      voiceProfileId: null,
    },
    places: [],
    knowledgeEntries: [
      {
        id: 'projection_1',
        title: 'Hours',
        category: 'POLICY',
        content,
        isEnabled: true as const,
        sourceType: 'UNIVERSAL_CONTENT',
        authorship: 'UNKNOWN',
        sourceName: 'POLICY v1',
        sourceUrl: null,
        importedAt: null,
        humanConfirmedAt: null,
        humanConfirmedBy: null,
        lastReviewedAt: null,
        lastReviewedBy: null,
        sourcePackageId: null,
      },
    ],
    generalizedModules: [],
  }
}

const currentReceipt = (overrides: Record<string, unknown> = {}) => ({
  id: 'receipt_1',
  proposalId: 'proposal_1',
  moduleId: 'module_1',
  revisionId: 'revision_1',
  module: {
    revisions: [{ id: 'revision_1', version: 1 }],
    publications: [{ id: 'publication_1', revisionId: 'revision_1', action: 'PUBLISH' }],
  },
  revision: {
    audience: 'PUBLIC',
    effectiveFrom: null,
    effectiveUntil: null,
    operationalFact: null,
  },
  ...overrides,
})

function reader(overrides: Record<string, unknown> = {}) {
  resolveNativeGuestReadSnapshot.mockResolvedValue({
    path: 'LEGACY',
    reason: 'SERVER_DISABLED',
    releaseId: null,
    state: null,
  })
  return {
    knowledgeChangeProposal: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'proposal_1',
          supportRequestId: 'request_1',
          supportRequestVersion: 4,
          status: 'APPROVED',
          packageHandoff: null,
          operationalUpdateHandoff: null,
          producedByConflictResolution: null,
        },
      ]),
    },
    supportRequestAuditEvent: { findUnique: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
    knowledgeProposalUniversalContentHandoff: {
      findMany: vi.fn().mockResolvedValue([currentReceipt()]),
    },
    legacyKnowledgeUniversalContentAdoption: { findMany: vi.fn().mockResolvedValue([]) },
    venueKnowledgeEntry: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'projection_1',
        title: 'Hours',
        category: 'POLICY',
        content: 'Open daily.',
        sourceType: 'UNIVERSAL_CONTENT',
        sourceName: 'POLICY v1',
        sourceUrl: null,
      }),
    },
    tenantFeatureFlag: { findFirst: vi.fn().mockResolvedValue(null) },
    nativeVenueDeploymentHead: { findFirst: vi.fn().mockResolvedValue(null) },
    nativeVenueDeploymentEvaluationEvidence: { findFirst: vi.fn().mockResolvedValue(null) },
    ...overrides,
  }
}

describe('support content fulfillment', () => {
  it('returns an empty bounded value when no source proposal is in scope', async () => {
    const db = reader({ knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([]) } })
    const value = await readSupportContentFulfillment(db as never, { ...scope, asOf })
    expect(value).toMatchObject({
      contractVersion: 1,
      receipts: [],
      guestRead: { path: 'NOT_APPLICABLE' },
    })
    expect(db.knowledgeChangeProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
        take: 101,
      }),
    )
  })

  it('allows an explicitly rejected source proposal with no content receipt', async () => {
    const db = reader({
      knowledgeChangeProposal: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'proposal_1',
            supportRequestId: 'request_1',
            supportRequestVersion: 4,
            status: 'REJECTED',
            packageHandoff: null,
            operationalUpdateHandoff: null,
            producedByConflictResolution: null,
          },
        ]),
      },
      knowledgeProposalUniversalContentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
    })
    const value = await readSupportContentFulfillment(db as never, { ...scope, asOf })
    expect(value).toMatchObject({ receipts: [], guestRead: { path: 'NOT_APPLICABLE' } })
    expect(db.tenantFeatureFlag.findFirst).not.toHaveBeenCalled()
  })

  it('reads one directly sourced current public published projection', async () => {
    const value = await readSupportContentFulfillment(reader() as never, { ...scope, asOf })
    expect(value.receipts).toEqual([
      expect.objectContaining({
        receiptKind: 'UNIVERSAL',
        sourceProposalId: 'proposal_1',
        sourceRequestVersion: 4,
        publicationId: 'publication_1',
        projectionId: 'projection_1',
      }),
    ])
    expect(value.guestRead.path).toBe('LEGACY')
  })

  it('returns adoption receipts with the same current-public projection proof', async () => {
    const db = reader({
      knowledgeProposalUniversalContentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
      legacyKnowledgeUniversalContentAdoption: {
        findMany: vi.fn().mockResolvedValue([currentReceipt()]),
      },
    })
    await expect(
      readSupportContentFulfillment(db as never, { ...scope, asOf }),
    ).resolves.toMatchObject({
      receipts: [expect.objectContaining({ receiptKind: 'ADOPTION' })],
    })
  })

  it('rejects a NATIVE snapshot whose same projection ID has drifted content', async () => {
    const db = reader()
    const state = nativeState('Native drift')
    resolveNativeGuestReadSnapshot.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId,
      state,
    })
    await expect(readSupportContentFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      'not guest observable in its published projection',
    )
  })

  it('records an exact matching NATIVE release and state hash', async () => {
    const db = reader()
    const state = nativeState('Open daily.')
    resolveNativeGuestReadSnapshot.mockResolvedValue({
      path: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId,
      state,
    })
    const value = await readSupportContentFulfillment(db as never, { ...scope, asOf })
    expect(value.guestRead).toEqual({
      path: 'NATIVE',
      releaseId,
      nativeStateHash: nativeCoreVisibleStateHash(state),
    })
  })

  it('uses one-hop replacement provenance and rejects a missing frozen source version', async () => {
    const db = reader({
      knowledgeChangeProposal: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'replacement_1',
            supportRequestId: null,
            supportRequestVersion: null,
            status: 'APPROVED',
            packageHandoff: null,
            operationalUpdateHandoff: null,
            producedByConflictResolution: {
              proposalId: 'proposal_1',
              proposal: {
                id: 'proposal_1',
                supportRequestId: 'request_1',
                supportRequestVersion: 4,
                producedByConflictResolution: null,
              },
            },
          },
        ]),
      },
      knowledgeProposalUniversalContentHandoff: {
        findMany: vi.fn().mockResolvedValue([currentReceipt({ proposalId: 'replacement_1' })]),
      },
    })
    await expect(
      readSupportContentFulfillment(db as never, { ...scope, asOf }),
    ).resolves.toMatchObject({
      receipts: [
        expect.objectContaining({ proposalId: 'replacement_1', sourceProposalId: 'proposal_1' }),
      ],
    })
    db.supportRequestAuditEvent.findUnique.mockResolvedValueOnce(null)
    await expect(readSupportContentFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      'Exact support request version evidence is unavailable.',
    )
  })

  it.each(['DRAFT', 'PENDING_REVIEW', 'APPROVED'] as const)(
    'blocks a %s source proposal without a verified receipt',
    async (status) => {
      const db = reader({
        knowledgeChangeProposal: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'proposal_1',
              supportRequestId: 'request_1',
              supportRequestVersion: 4,
              status,
              packageHandoff: null,
              operationalUpdateHandoff: null,
              producedByConflictResolution: null,
            },
          ]),
        },
        knowledgeProposalUniversalContentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
      })
      await expect(readSupportContentFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
        'has no verified content or package fulfillment',
      )
    },
  )

  it('allows only an exact package handoff already verified by the package layer', async () => {
    const proposal = {
      id: 'proposal_1',
      supportRequestId: 'request_1',
      supportRequestVersion: 4,
      status: 'APPROVED',
      packageHandoff: { venuePackageId: 'package_1' },
      operationalUpdateHandoff: null,
      producedByConflictResolution: null,
    }
    const allowed = reader({
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([proposal]) },
      knowledgeProposalUniversalContentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
    })
    await expect(
      readSupportContentFulfillment(allowed as never, {
        ...scope,
        asOf,
        verifiedPackageIds: ['package_1'],
      }),
    ).resolves.toMatchObject({ receipts: [] })
    const blocked = reader({
      knowledgeChangeProposal: { findMany: vi.fn().mockResolvedValue([proposal]) },
      knowledgeProposalUniversalContentHandoff: { findMany: vi.fn().mockResolvedValue([]) },
    })
    await expect(
      readSupportContentFulfillment(blocked as never, {
        ...scope,
        asOf,
        verifiedPackageIds: ['other-package'],
      }),
    ).rejects.toThrow('has no verified content or package fulfillment')
  })

  it.each([
    [
      'private',
      {
        revision: {
          audience: 'CLIENT',
          effectiveFrom: null,
          effectiveUntil: null,
          operationalFact: null,
        },
      },
      'not public',
    ],
    [
      'withdrawn',
      {
        module: {
          revisions: [{ id: 'revision_1', version: 1 }],
          publications: [{ id: 'publication_2', revisionId: 'revision_1', action: 'WITHDRAW' }],
        },
      },
      'not currently published',
    ],
    [
      'newer',
      {
        module: {
          revisions: [{ id: 'revision_2', version: 2 }],
          publications: [{ id: 'publication_2', revisionId: 'revision_2', action: 'PUBLISH' }],
        },
      },
      'stale',
    ],
    [
      'expired',
      {
        revision: {
          audience: 'PUBLIC',
          effectiveFrom: null,
          effectiveUntil: null,
          operationalFact: { expiresAt: new Date('2026-09-10T11:59:59.000Z') },
        },
      },
      'not currently effective',
    ],
  ])('fails closed for %s content', async (_name, patch, message) => {
    const db = reader({
      knowledgeProposalUniversalContentHandoff: {
        findMany: vi.fn().mockResolvedValue([currentReceipt(patch)]),
      },
    })
    await expect(readSupportContentFulfillment(db as never, { ...scope, asOf })).rejects.toThrow(
      message,
    )
  })

  it('rejects a missing public projection and ignores verification time in the digest', async () => {
    const missing = reader({ venueKnowledgeEntry: { findFirst: vi.fn().mockResolvedValue(null) } })
    await expect(
      readSupportContentFulfillment(missing as never, { ...scope, asOf }),
    ).rejects.toThrow('has no public projection')
    const value = await readSupportContentFulfillment(reader() as never, { ...scope, asOf })
    const identity = {
      contractVersion: value.contractVersion,
      receipts: value.receipts,
      guestRead: value.guestRead,
    }
    expect(supportContentFulfillmentDigest(identity)).toBe(value.digest)
  })
})
