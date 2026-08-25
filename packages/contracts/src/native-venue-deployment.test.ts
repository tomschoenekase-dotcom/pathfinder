import { describe, expect, it } from 'vitest'

import { GeneralizedContentRevisionDraft } from './universal-content-actions'

import {
  canonicalNativeCoreFullManifest,
  NativeCoreFullManifest,
  nativeCoreFullManifestHash,
} from './native-venue-deployment'

const envelope = {
  schemaVersion: 2 as const,
  packageType: 'FULL' as const,
  materializationProfile: 'NATIVE_CORE_V1' as const,
  manifestId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
  venueRef: 'venue-1',
  provenance: {
    sourceIds: ['source:b', 'source:a'],
    evidenceIds: ['evidence:b', 'evidence:a'],
    createdAt: '2026-08-12T12:00:00.000Z',
    createdBy: { kind: 'OPERATOR' as const, actorRef: 'admin-1' },
  },
  venue: {
    name: 'Venue',
    slug: 'venue',
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
  places: [],
  knowledgeEntries: [],
  generalizedModules: [],
  items: [] as [],
  assets: [] as [],
  capabilityOverrides: [] as [],
  modelReferences: [] as [],
  evaluation: {
    status: 'NOT_REQUIRED_FOR_CORE_PROFILE' as const,
    policyVersion: 'native-core-v1' as const,
  },
  baseState: {
    stateHash: 'a'.repeat(64),
    activePlaceIds: [],
    enabledKnowledgeEntryIds: [],
    publishedGeneralizedHeads: [],
  },
}

describe('NATIVE_CORE_V1 FULL manifest', () => {
  it('is explicit, lossless-shaped, and hash-stable across set-like order', () => {
    expect(NativeCoreFullManifest.parse(envelope).materializationProfile).toBe('NATIVE_CORE_V1')
    const reversed = {
      ...envelope,
      provenance: {
        ...envelope.provenance,
        sourceIds: [...envelope.provenance.sourceIds].reverse(),
        evidenceIds: [...envelope.provenance.evidenceIds].reverse(),
      },
    }
    expect(nativeCoreFullManifestHash(reversed)).toBe(nativeCoreFullManifestHash(envelope))
    expect(canonicalNativeCoreFullManifest(envelope)).toContain('NOT_REQUIRED_FOR_CORE_PROFILE')
  })

  it('carries Venue Bot presentation independently while preserving older manifests', () => {
    expect(NativeCoreFullManifest.safeParse(envelope).success).toBe(true)
    const withCharacter = {
      ...envelope,
      venueBotConfiguration: {
        presentationMode: 'CHARACTER',
        personalityMode: 'PRESET',
        tonePreset: 'friendly',
        tonePresetVersion: 1,
        responseDepth: 'BALANCED',
        personalityProfileId: null,
        characterKey: 'tochi',
        customCharacterId: null,
        publicDisplayName: 'Tochi',
        greeting: null,
        voiceProfileId: null,
      },
    }
    expect(NativeCoreFullManifest.safeParse(withCharacter).success).toBe(true)
    expect(
      NativeCoreFullManifest.safeParse({
        ...withCharacter,
        venueBotConfiguration: {
          ...withCharacter.venueBotConfiguration,
          characterKey: null,
        },
      }).success,
    ).toBe(false)
    expect(nativeCoreFullManifestHash(withCharacter)).not.toBe(nativeCoreFullManifestHash(envelope))
  })

  it('fails closed for unsupported nonempty sections and unsafe locators', () => {
    expect(
      NativeCoreFullManifest.safeParse({ ...envelope, items: [{ id: 'item-1' }] }).success,
    ).toBe(false)
    expect(
      NativeCoreFullManifest.safeParse({
        ...envelope,
        venue: { ...envelope.venue, chatLogoUrl: 'https://example.com/a?token=secret' },
      }).success,
    ).toBe(false)
    for (const chatLogoUrl of [
      'http://example.com/logo.png',
      'ftp://example.com/logo.png',
      'https://user:secret@example.com/logo.png',
    ])
      expect(
        NativeCoreFullManifest.safeParse({
          ...envelope,
          venue: { ...envelope.venue, chatLogoUrl },
        }).success,
      ).toBe(false)
  })

  it('keeps universal ITEM authoring separate from the unchanged native empty-items profile', () => {
    expect(
      GeneralizedContentRevisionDraft.safeParse({
        audience: 'PUBLIC',
        evidence: [],
        payload: {
          kind: 'ITEM',
          name: 'Apollo guidance computer',
          itemType: 'artifact',
        },
      }).success,
    ).toBe(true)
    expect(
      NativeCoreFullManifest.safeParse({ ...envelope, items: [{ id: 'item-1' }] }).success,
    ).toBe(false)
  })

  it('rejects secret-like evidence locators and unbounded manifest scalars', () => {
    const generalizedModules = [
      {
        moduleId: 'module-1',
        kind: 'OPERATIONAL_FACT' as const,
        version: 1,
        revisionId: 'revision-1',
        audience: 'PUBLIC' as const,
        effectiveFrom: null,
        effectiveUntil: null,
        evidence: [
          {
            sourceId: 'source-1',
            locator: 'https://example.com/evidence?token=secret',
            capturedAt: '2026-08-12T12:00:00.000Z',
            excerptHash: null,
          },
        ],
        payload: {
          kind: 'OPERATIONAL_FACT' as const,
          label: 'Open',
          value: 'Yes',
          expiresAt: null,
        },
        publication: { status: 'PUBLISHED' as const, revisionId: 'revision-1' },
      },
    ]
    expect(NativeCoreFullManifest.safeParse({ ...envelope, generalizedModules }).success).toBe(
      false,
    )
    expect(
      NativeCoreFullManifest.safeParse({
        ...envelope,
        venue: { ...envelope.venue, slug: 'a'.repeat(192) },
      }).success,
    ).toBe(false)
  })

  it('requires exact references and published revision parity', () => {
    const module = {
      moduleId: 'module-1',
      kind: 'SERVICE' as const,
      version: 1,
      revisionId: 'revision-1',
      audience: 'PUBLIC' as const,
      effectiveFrom: null,
      effectiveUntil: null,
      evidence: [],
      payload: {
        kind: 'SERVICE' as const,
        name: 'Cafe',
        description: null,
        availability: null,
        placeId: 'missing',
      },
      publication: { status: 'PUBLISHED' as const, revisionId: 'revision-other' },
    }
    const result = NativeCoreFullManifest.safeParse({ ...envelope, generalizedModules: [module] })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining([
          'generalizedModules.0.payload.placeId',
          'generalizedModules.0.publication.revisionId',
        ]),
      )
  })
})
