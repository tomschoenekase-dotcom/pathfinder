import { describe, expect, it, vi } from 'vitest'

import { nativeCoreVisibleStateHash } from '@pathfinder/contracts'

import {
  applyNativeGuestContentRead,
  assessNativeGuestReadActivationAction,
  resolveNativeGuestReadSnapshotAction,
} from './native-guest-content-read'

const releaseId = '11111111-1111-4111-8111-111111111111'
const evidenceId = '22222222-2222-4222-8222-222222222222'
const state = {
  venue: {
    name: 'Native Venue',
    slug: 'native-venue',
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
    tonePresetVersion: 1 as const,
    personalityProfileId: null,
    characterKey: null,
    customCharacterId: null,
    publicDisplayName: null,
    greeting: null,
    voiceProfileId: null,
  },
  places: [
    {
      id: 'place-1',
      name: 'Native Place',
      type: 'EXHIBIT',
      itemType: null,
      shortDescription: 'Native truth',
      longDescription: null,
      lat: null,
      lng: null,
      tags: [],
      importanceScore: 50,
      areaName: null,
      hours: null,
      photoUrl: null,
      isActive: true as const,
      sourceType: 'FOUNDER',
      authorship: 'HUMAN',
      sourceName: null,
      sourceUrl: null,
      importedAt: null,
      humanConfirmedAt: null,
      humanConfirmedBy: null,
      lastReviewedAt: null,
      lastReviewedBy: null,
      sourcePackageId: null,
    },
  ],
  knowledgeEntries: [],
  generalizedModules: [],
}

function client(metadata: unknown = policy()) {
  const hash = nativeCoreVisibleStateHash(state)
  return {
    tenantFeatureFlag: { findFirst: vi.fn().mockResolvedValue({ enabled: true, metadata }) },
    nativeVenueDeploymentHead: {
      findFirst: vi.fn().mockResolvedValue({
        releaseId,
        artifactId: releaseId,
        manifestHash: 'a'.repeat(64),
        stateHash: hash,
        release: {
          id: releaseId,
          artifactId: releaseId,
          manifestHash: 'a'.repeat(64),
          desiredStateHash: hash,
          status: 'APPLIED',
          plan: { desired: state },
        },
      }),
    },
    nativeVenueDeploymentEvaluationEvidence: {
      findFirst: vi.fn().mockResolvedValue({ id: evidenceId }),
    },
  }
}

function policy(mode: 'DARK' | 'ACTIVE' = 'ACTIVE') {
  return {
    schemaVersion: 1,
    mode,
    venueId: 'venue-1',
    targetReleaseId: releaseId,
    evaluationEvidenceId: evidenceId,
    qualityPolicyRef: 'policy://founder-reviewed-quality-v1',
    rollbackRehearsalRef: 'evidence://native-revert-rehearsal',
    productionApprovalRef: null,
  }
}

describe('native guest content read', () => {
  it('is server-disabled by default without consulting persisted policy', async () => {
    const db = client()
    const result = await resolveNativeGuestReadSnapshotAction({
      client: db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: {},
    })
    expect(result).toMatchObject({ path: 'LEGACY', reason: 'SERVER_DISABLED' })
    expect(db.tenantFeatureFlag.findFirst).not.toHaveBeenCalled()
  })

  it('requires exact policy, active head, passing evidence, and a non-production runtime', async () => {
    const db = client()
    const result = await resolveNativeGuestReadSnapshotAction({
      client: db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: { NATIVE_GUEST_CONTENT_READ_ENABLED: 'true', RAILWAY_ENVIRONMENT: 'staging' },
    })
    expect(result).toMatchObject({ path: 'NATIVE', reason: 'NATIVE_READY', releaseId })
    expect(db.tenantFeatureFlag.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          flagKey: 'native-guest-content-read-v1:venue-1',
        }),
      }),
    )
  })

  it('keeps dark mode non-executing and requires a distinct production approval reference', async () => {
    const dark = await resolveNativeGuestReadSnapshotAction({
      client: client(policy('DARK')),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: { NATIVE_GUEST_CONTENT_READ_ENABLED: 'true', RAILWAY_ENVIRONMENT: 'staging' },
    })
    expect(dark.path).toBe('DARK')
    const production = await resolveNativeGuestReadSnapshotAction({
      client: client(),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: { NATIVE_GUEST_CONTENT_READ_ENABLED: 'true', RAILWAY_ENVIRONMENT: 'production' },
    })
    expect(production).toMatchObject({ path: 'LEGACY', reason: 'PRODUCTION_APPROVAL_MISSING' })
  })

  it('reports every observed gate while the server kill switch remains disabled', async () => {
    const db = client(policy('DARK'))
    const preflight = await assessNativeGuestReadActivationAction({
      client: db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: { RAILWAY_ENVIRONMENT: 'staging' },
    })
    expect(preflight).toMatchObject({
      contractVersion: 1,
      runtime: { serverGateEnabled: false, production: false },
      policy: {
        present: true,
        enabled: true,
        valid: true,
        mode: 'DARK',
        qualityPolicyReferencePresent: true,
        rollbackRehearsalReferencePresent: true,
        productionApprovalReferencePresent: false,
      },
      head: { present: true, valid: true, targetMatches: true, releaseId },
      evaluation: { valid: true, evidenceId },
      path: 'LEGACY',
      reason: 'SERVER_DISABLED',
      readyForConfiguredMode: false,
      nativeExecutionReady: false,
      blockers: ['SERVER_GATE_DISABLED'],
      compatibilityDataRetentionRequired: true,
      mutationPerformed: false,
    })
    expect(db.tenantFeatureFlag.findFirst).toHaveBeenCalledTimes(1)
  })

  it('distinguishes disabled venue policy and production approval without inventing quality gates', async () => {
    const db = client(policy())
    db.tenantFeatureFlag.findFirst.mockResolvedValue({ enabled: false, metadata: policy() })
    db.nativeVenueDeploymentEvaluationEvidence.findFirst.mockResolvedValue(null)
    const preflight = await assessNativeGuestReadActivationAction({
      client: db,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      environment: {
        NATIVE_GUEST_CONTENT_READ_ENABLED: 'true',
        RAILWAY_ENVIRONMENT: 'production',
      },
    })
    expect(preflight.path).toBe('LEGACY')
    expect(preflight.reason).toBe('POLICY_MISSING')
    expect(preflight.blockers).toEqual([
      'VENUE_POLICY_DISABLED',
      'PRODUCTION_APPROVAL_REQUIRED',
      'EVALUATION_EVIDENCE_INVALID',
    ])
    expect(preflight.policy.qualityPolicyRef).toBe('policy://founder-reviewed-quality-v1')
    expect(preflight).not.toHaveProperty('qualityThreshold')
  })

  it('uses compatibility rows only for authorization/ranking and preserves ranking metadata', () => {
    const legacyPlace = {
      id: 'place-1',
      name: 'Legacy Place',
      type: 'EXHIBIT',
      itemType: null,
      shortDescription: 'Legacy text',
      longDescription: null,
      lat: null,
      lng: null,
      tags: [],
      areaName: null,
      hours: null,
      photoUrl: null,
      sourceType: 'LEGACY',
      sourceName: null,
      sourceUrl: null,
      distance: 0.12,
    }
    const result = applyNativeGuestContentRead({
      snapshot: { path: 'NATIVE', reason: 'NATIVE_READY', releaseId, state },
      legacyPlaces: [legacyPlace],
      legacyKnowledgeEntries: [],
    })
    expect(result).toMatchObject({
      path: 'NATIVE',
      places: [
        { id: 'place-1', name: 'Native Place', shortDescription: 'Native truth', distance: 0.12 },
      ],
    })
  })

  it('falls the whole collection back when an authorized compatibility ID is absent', () => {
    const missing = {
      id: 'legacy-only',
      name: 'Legacy only',
      type: 'EXHIBIT',
      itemType: null,
      shortDescription: null,
      longDescription: null,
      lat: null,
      lng: null,
      tags: [],
      areaName: null,
      hours: null,
      photoUrl: null,
      sourceType: 'LEGACY',
      sourceName: null,
      sourceUrl: null,
    }
    const result = applyNativeGuestContentRead({
      snapshot: { path: 'NATIVE', reason: 'NATIVE_READY', releaseId, state },
      legacyPlaces: [missing],
      legacyKnowledgeEntries: [],
    })
    expect(result.path).toBe('LEGACY')
    expect(result.places[0]?.name).toBe('Legacy only')
  })
})
