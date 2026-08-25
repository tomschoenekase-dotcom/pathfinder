import { describe, expect, it } from 'vitest'

import {
  deploymentManifestDraftInput,
  deploymentManifestPreviewInput,
  previewDeploymentManifestConversion,
} from './venue-deployment-manifest'

const provenance = {
  sourceIds: ['source_interview'],
  evidenceIds: ['evidence_hours'],
  createdAt: '2026-08-11T20:00:00.000Z',
  createdBy: { kind: 'OPERATOR' as const, actorRef: 'user_1' },
}
const VENUE_ID = 'cm00000000000000000000009'

function patch(operations: unknown[]) {
  return {
    schemaVersion: 2,
    packageType: 'PATCH',
    manifestId: '00000000-0000-4000-8000-000000000001',
    venueRef: VENUE_ID,
    idempotencyKey: '00000000-0000-4000-8000-000000000002',
    baseManifestHash: 'a'.repeat(64),
    provenance,
    operations,
  }
}

describe('venue deployment manifest lifecycle bridge', () => {
  it('converts granular knowledge upsert and retire operations into existing v3 operations', () => {
    const manifest = patch([
      {
        operationId: '00000000-0000-4000-8000-000000000011',
        op: 'UPSERT_CONTENT_MODULE',
        value: {
          id: 'knowledge_hours',
          kind: 'KNOWLEDGE',
          version: 1,
          audience: 'PUBLIC',
          title: 'Hours',
          body: 'Open daily from 9am to 5pm.',
          topics: ['Hours'],
          evidence: [],
          assetIds: [],
        },
      },
      {
        operationId: '00000000-0000-4000-8000-000000000012',
        op: 'RETIRE_CONTENT_MODULE',
        moduleKind: 'KNOWLEDGE',
        moduleId: 'cm00000000000000000000001',
        expectedVersion: 2,
      },
    ])

    const result = deploymentManifestPreviewInput({ venueId: VENUE_ID, manifest })

    expect(result.converted.compatible).toBe(true)
    expect(result.previewInput).toEqual(
      expect.objectContaining({
        venueId: VENUE_ID,
        payload: expect.objectContaining({ schemaVersion: 3 }),
      }),
    )
    const payload = result.previewInput?.payload
    expect(payload?.schemaVersion).toBe(3)
    if (!payload || payload.schemaVersion !== 3) throw new Error('Expected v3 bridge payload')
    expect(payload.knowledgeEntries.create).toEqual([
      expect.objectContaining({
        itemKey: '00000000-0000-4000-8000-000000000011',
        value: {
          title: 'Hours',
          category: 'Hours',
          content: 'Open daily from 9am to 5pm.',
          isEnabled: true,
        },
      }),
    ])
    expect(payload.knowledgeEntries.delete).toEqual([
      expect.objectContaining({
        itemKey: '00000000-0000-4000-8000-000000000012',
        id: 'cm00000000000000000000001',
      }),
    ])
    expect(result.converted.issues).toContainEqual(
      expect.objectContaining({ severity: 'WARNING', code: 'BASE_HASH_DELEGATED' }),
    )
  })

  it('creates an exact existing draft input using the manifest idempotency key', () => {
    const manifest = patch([
      {
        operationId: '00000000-0000-4000-8000-000000000021',
        op: 'RESET_CONFIGURATION',
        path: 'branding.accentColor',
      },
    ])

    const result = deploymentManifestDraftInput({ venueId: VENUE_ID, manifest })

    expect(result.draftInput).toEqual({
      venueId: VENUE_ID,
      draftKey: '00000000-0000-4000-8000-000000000002',
      payload: {
        schemaVersion: 3,
        venue: { branding: { chatAccentColor: null } },
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
    })
    expect(result.converted.handoff).toEqual({
      previewProcedure: 'venuePackage.preview',
      draftProcedure: 'venuePackage.createDraft',
      approvalProcedure: 'venuePackage.approve',
      applyProcedure: 'venuePackage.applyPackage',
      rollbackProcedure: 'venuePackage.revertPackage',
    })
  })

  it('refuses unsupported reset, asset, capability, and model semantics instead of dropping them', () => {
    const manifest = patch([
      {
        operationId: '00000000-0000-4000-8000-000000000031',
        op: 'RESET_CONTENT_FIELD',
        moduleKind: 'PLACE',
        moduleId: 'cm00000000000000000000002',
        field: 'description',
      },
      {
        operationId: '00000000-0000-4000-8000-000000000032',
        op: 'SET_CAPABILITY',
        capabilityId: 'events',
        enabled: true,
        provenance: {
          key: 'capability.events',
          sourceLayer: 'venue-override',
          sourceId: VENUE_ID,
        },
      },
      {
        operationId: '00000000-0000-4000-8000-000000000033',
        op: 'UPSERT_ASSET',
        value: {
          assetId: 'asset_logo',
          sha256: 'b'.repeat(64),
          mediaType: 'image/png',
          byteSize: 10,
          immutableRef: `asset:sha256/${'b'.repeat(64)}`,
        },
      },
      {
        operationId: '00000000-0000-4000-8000-000000000034',
        op: 'UPSERT_AI_CONFIGURATION',
        value: {
          tone: { preset: 'friendly', behaviorVersion: 1 },
          venueBot: {
            presentationMode: 'CLASSIC',
            personalityMode: 'PRESET',
            tonePreset: 'friendly',
            tonePresetVersion: 1,
            responseDepth: 'BALANCED',
            personalityProfileId: null,
            characterKey: null,
            customCharacterId: null,
            publicDisplayName: null,
            greeting: null,
            voiceProfileId: null,
          },
          modelReferences: [
            { purpose: 'CHAT', provider: 'openai', modelRef: 'gpt-5-mini', configVersion: 1 },
          ],
        },
      },
    ])

    const result = deploymentManifestDraftInput({ venueId: VENUE_ID, manifest })

    expect(result.draftInput).toBeNull()
    expect(
      result.converted.issues
        .filter((issue) => issue.severity === 'ERROR')
        .map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        'OPERATION_NOT_SUPPORTED',
        'MODEL_REFERENCE_NOT_SUPPORTED',
        'VENUE_BOT_CONFIGURATION_REQUIRES_NATIVE_PROFILE',
      ]),
    )
  })

  it('rejects venue scope mismatches and FULL conversion without touching persistence', () => {
    const mismatch = previewDeploymentManifestConversion({
      venueId: 'venue_other',
      manifest: patch([
        {
          operationId: '00000000-0000-4000-8000-000000000041',
          op: 'RESET_CONFIGURATION',
          path: 'branding.accentColor',
        },
      ]),
    })
    expect(mismatch.compatible).toBe(false)
    expect(mismatch.issues).toContainEqual(
      expect.objectContaining({ code: 'VENUE_SCOPE_MISMATCH' }),
    )

    const invalidFull = previewDeploymentManifestConversion({
      venueId: VENUE_ID,
      manifest: { ...patch([]), packageType: 'FULL' },
    })
    expect(invalidFull.compatible).toBe(false)
    expect(invalidFull.payload).toBeNull()
  })
})
