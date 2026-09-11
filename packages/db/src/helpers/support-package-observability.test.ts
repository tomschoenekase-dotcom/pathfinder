import { describe, expect, it, vi } from 'vitest'

import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'

import { readSupportPackageGuestObservability } from './support-package-observability'

const packageId = 'package_1'
const entityId = '11111111-1111-4111-8111-111111111111'
const applyVersionId = '22222222-2222-4222-8222-222222222222'
const itemKey = '33333333-3333-4333-8333-333333333333'
const afterState = {
  id: entityId,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  title: 'Entrance hours',
  category: 'Visitor information',
  content: 'The east entrance opens at 9 AM.',
  isEnabled: true,
  visibility: 'PUBLIC',
  sourceType: 'SUPPORT_REQUEST',
  sourceName: 'Reviewed support request',
  sourceUrl: null,
  sourcePackageId: packageId,
}

const releaseId = '44444444-4444-4444-8444-444444444444'
const evaluationEvidenceId = '55555555-5555-4555-8555-555555555555'

function nativeState(content = afterState.content) {
  return {
    venue: {
      name: 'Fixture venue',
      slug: 'fixture-venue',
      description: null,
      guideNotes: null,
      aiGuideNotes: null,
      aiFeaturedPlaceId: null,
      aiTone: 'FRIENDLY',
      tonePreset: 'friendly',
      tonePresetVersion: 1,
      aiGuideName: null,
      chatTheme: 'default',
      chatAccentColor: null,
      chatFont: 'jakarta',
      chatLogoUrl: null,
      chatBannerUrl: null,
      category: null,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      geoBoundary: null,
      isActive: true,
    },
    venueBotConfiguration: {
      presentationMode: 'CLASSIC' as const,
      personalityMode: 'PRESET' as const,
      tonePreset: 'friendly' as const,
      tonePresetVersion: 1 as const,
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
        id: entityId,
        title: afterState.title,
        category: afterState.category,
        content,
        isEnabled: true as const,
        sourceType: afterState.sourceType,
        authorship: 'HUMAN',
        sourceName: afterState.sourceName,
        sourceUrl: null,
        importedAt: null,
        humanConfirmedAt: null,
        humanConfirmedBy: null,
        lastReviewedAt: null,
        lastReviewedBy: null,
        sourcePackageId: packageId,
      },
    ],
    generalizedModules: [],
  }
}

function activateNative(client: ReturnType<typeof fixture>['client'], content?: string) {
  const state = nativeState(content)
  Object.assign(client, {
    tenantFeatureFlag: {
      findFirst: vi.fn().mockResolvedValue({
        enabled: true,
        metadata: {
          schemaVersion: 1,
          mode: 'ACTIVE',
          venueId: 'venue_1',
          targetReleaseId: releaseId,
          evaluationEvidenceId,
          qualityPolicyRef: 'policy://fixture-quality',
          rollbackRehearsalRef: 'evidence://fixture-rehearsal',
          productionApprovalRef: null,
        },
      }),
    },
    nativeVenueDeploymentHead: {
      findFirst: vi.fn().mockResolvedValue({
        releaseId,
        artifactId: releaseId,
        manifestHash: 'b'.repeat(64),
        stateHash: nativeCoreVisibleStateHash(state),
        release: {
          id: releaseId,
          artifactId: releaseId,
          manifestHash: 'b'.repeat(64),
          desiredStateHash: nativeCoreVisibleStateHash(state),
          status: 'APPLIED',
          plan: { desired: state },
        },
      }),
    },
    nativeVenueDeploymentEvaluationEvidence: {
      findFirst: vi.fn().mockResolvedValue({ id: evaluationEvidenceId }),
    },
  })
}

function fixture(
  options: {
    operation?: 'UPDATE' | 'DELETE'
    currentContent?: string
    currentEnabled?: boolean
  } = {},
) {
  const operation = options.operation ?? 'UPDATE'
  const effect = {
    itemKey,
    entityType: 'KNOWLEDGE_ENTRY' as const,
    entityId,
    operation,
    applyVersionId,
    snapshotSchemaVersion: 1,
    beforeState: { ...afterState, content: 'The east entrance opens at 10 AM.' },
    afterState:
      operation === 'DELETE'
        ? null
        : { ...afterState, ...(options.currentEnabled === false ? { isEnabled: false } : {}) },
  }
  const current = {
    ...afterState,
    ...(options.currentContent ? { content: options.currentContent } : {}),
    ...(options.currentEnabled === false ? { isEnabled: false } : {}),
  }
  const client = {
    contentVersion: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: applyVersionId,
          venuePackageId: packageId,
          entityType: effect.entityType,
          entityId,
          operation,
          beforeState: effect.beforeState,
          afterState: effect.afterState,
        },
      ]),
    },
    venue: { findFirst: vi.fn().mockResolvedValue({ id: 'venue_1' }) },
    place: { findMany: vi.fn().mockResolvedValue([]) },
    venueKnowledgeEntry: {
      findMany: vi.fn().mockResolvedValue(operation === 'DELETE' ? [] : [current]),
    },
  }
  return {
    client,
    input: {
      client: client as never,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      packages: [
        {
          packageId,
          schemaVersion: 3,
          appliedEntities: {
            schemaVersion: 3,
            rollbackContractVersion: 2,
            postApplyDigest: 'a'.repeat(64),
            effects: [effect],
          },
        },
      ],
      environment: {},
      verifiedAt: new Date('2026-09-07T12:00:00.000Z'),
    },
  }
}

describe('support package guest observability', () => {
  it.each([1, 2])(
    'does not infer schema v%i package identity from unbound historical content versions',
    async (schemaVersion) => {
      const contentVersion = {
        findMany: vi.fn().mockResolvedValue([
          {
            id: applyVersionId,
            venuePackageId: null,
            venuePackageAction: null,
            venuePackageItemKey: null,
            entityType: 'KNOWLEDGE_ENTRY',
            entityId,
            operation: 'CREATE',
            beforeState: null,
            afterState,
          },
        ]),
      }
      await expect(
        readSupportPackageGuestObservability({
          client: { contentVersion } as never,
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          packages: [
            {
              packageId,
              schemaVersion,
              appliedEntities:
                schemaVersion === 1
                  ? {
                      postApplyDigest: 'a'.repeat(64),
                      places: [],
                      knowledgeEntries: [
                        {
                          id: entityId,
                          title: afterState.title,
                          category: afterState.category,
                          content: afterState.content,
                          isEnabled: true,
                        },
                      ],
                    }
                  : {
                      schemaVersion: 2,
                      postApplyDigest: 'a'.repeat(64),
                      venue: null,
                      places: [],
                      knowledgeEntries: [
                        {
                          id: entityId,
                          title: afterState.title,
                          category: afterState.category,
                          content: afterState.content,
                          isEnabled: true,
                        },
                      ],
                    },
            },
          ],
        }),
      ).rejects.toThrow(
        `schema version ${schemaVersion} does not record immutable applyVersionId, itemKey, and package-action bindings; apply a reviewed V3 replacement and supersede this handoff`,
      )
      expect(contentVersion.findMany).not.toHaveBeenCalled()
    },
  )

  it('hashes the exact changed fields selected by the production legacy read path', async () => {
    const { input } = fixture()
    const result = await readSupportPackageGuestObservability(input)
    expect(result).toMatchObject({
      configuredPath: 'LEGACY',
      reason: 'SERVER_DISABLED',
      releaseId: null,
      nativeStateHash: null,
      effects: [
        {
          packageId,
          applyVersionId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId,
          operation: 'UPDATE',
          readPath: 'LEGACY',
        },
      ],
      verifiedAt: '2026-09-07T12:00:00.000Z',
    })
    expect(result.effects[0]!.expectedGuestStateHash).toBe(
      result.effects[0]!.observedGuestStateHash,
    )
  })

  it('holds completion when current guest content drifted after package application', async () => {
    const { input } = fixture({ currentContent: 'The east entrance opens at noon.' })
    await expect(readSupportPackageGuestObservability(input)).rejects.toThrow(
      'knowledge entry 11111111-1111-4111-8111-111111111111 differs from its apply evidence in legacy state',
    )
  })

  it('uses the actual active native snapshot and holds when it is stale', async () => {
    const exact = fixture()
    activateNative(exact.client)
    const result = await readSupportPackageGuestObservability({
      ...exact.input,
      environment: {
        NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
        RAILWAY_ENVIRONMENT: 'staging',
      },
    })
    expect(result).toMatchObject({
      configuredPath: 'NATIVE',
      reason: 'NATIVE_READY',
      releaseId,
      nativeStateHash: nativeCoreVisibleStateHash(nativeState()),
      effects: [{ readPath: 'NATIVE' }],
    })

    const stale = fixture()
    activateNative(stale.client, 'Stale native guidance.')
    await expect(
      readSupportPackageGuestObservability({
        ...stale.input,
        environment: {
          NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
          RAILWAY_ENVIRONMENT: 'staging',
        },
      }),
    ).rejects.toThrow('differs from its apply evidence')
  })

  it('treats a deleted entity as observable only while the public compatibility row is absent', async () => {
    const deleted = fixture({ operation: 'DELETE' })
    await expect(readSupportPackageGuestObservability(deleted.input)).resolves.toMatchObject({
      effects: [
        {
          operation: 'DELETE',
          expectedGuestStateHash: null,
          observedGuestStateHash: null,
        },
      ],
    })

    deleted.client.venueKnowledgeEntry.findMany.mockResolvedValueOnce([
      { ...afterState, isEnabled: false },
    ])
    await expect(readSupportPackageGuestObservability(deleted.input)).rejects.toThrow(
      'differs from its apply evidence',
    )
  })

  it('accepts an exact public deactivation only when it is absent from the guest read', async () => {
    const deactivated = fixture({ currentEnabled: false })
    await expect(readSupportPackageGuestObservability(deactivated.input)).resolves.toMatchObject({
      effects: [
        {
          operation: 'UPDATE',
          expectedGuestStateHash: null,
          observedGuestStateHash: null,
        },
      ],
    })
  })
})
