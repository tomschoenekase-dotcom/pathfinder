import { describe, expect, it, vi } from 'vitest'

import {
  canonicalDeploymentManifest,
  deploymentManifestHash,
  VenueDeploymentFullManifest,
} from '@pathfinder/contracts/venue-deployment-manifest'

import {
  FullManifestProjectionError,
  projectFullVenueDeploymentManifest,
} from './full-venue-deployment-manifest'

const envelope = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  manifestId: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
}

function harness(overrides: Record<string, unknown> = {}) {
  const findFirst = vi.fn().mockResolvedValue({
    id: 'venue-1',
    name: 'Museum',
    slug: 'museum',
    description: 'A public description.',
    category: 'museum',
    tonePreset: 'friendly',
    tonePresetVersion: 1,
    aiTone: 'FRIENDLY',
    aiGuideName: 'Ari',
    chatTheme: 'forest',
    chatAccentColor: '#123ABC',
    chatFont: 'inter',
    chatLogoUrl: 'https://private.invalid/logo.png?token=secret-logo',
    chatBannerUrl: null,
    isActive: true,
    updatedAt: new Date('2026-08-11T20:00:00.000Z'),
    ...overrides,
  })
  return { findFirst, client: { venue: { findFirst } } }
}

describe('FULL venue deployment manifest projection', () => {
  it('projects one exact tenant/venue scope with an explicit privacy-safe select', async () => {
    const h = harness()
    const result = await projectFullVenueDeploymentManifest(envelope, h.client as never)

    expect(h.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue-1', tenantId: 'tenant-1' },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: true,
        tonePreset: true,
        tonePresetVersion: true,
        aiTone: true,
        aiGuideName: true,
        chatTheme: true,
        chatAccentColor: true,
        chatFont: true,
        chatLogoUrl: true,
        chatBannerUrl: true,
        isActive: true,
        updatedAt: true,
        venueBotConfiguration: {
          select: {
            presentationMode: true,
            personalityMode: true,
            tonePreset: true,
            tonePresetVersion: true,
            responseDepth: true,
            personalityProfileId: true,
            characterKey: true,
            customCharacterId: true,
            publicDisplayName: true,
            greeting: true,
            voiceProfileId: true,
          },
        },
      },
    })
    expect(VenueDeploymentFullManifest.parse(result.manifest)).toEqual(result.manifest)
    expect(result.manifest).toMatchObject({
      schemaVersion: 2,
      packageType: 'FULL',
      manifestId: envelope.manifestId,
      idempotencyKey: envelope.idempotencyKey,
      venueRef: 'venue-1',
      identity: { archetype: 'museum' },
      evaluation: { readiness: 'NOT_READY' },
    })
    expect(result.manifest.contentModules).toEqual([])
    expect(result.manifest.assets).toEqual([])
    expect(result.readiness.readyForApply).toBe(false)
  })

  it('projects canonical Venue Bot presentation without private workflow or asset state', async () => {
    const h = harness({
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
        greeting: 'What can I help you find?',
        voiceProfileId: null,
      },
    })
    const result = await projectFullVenueDeploymentManifest(envelope, h.client as never)
    expect(result.manifest.aiConfiguration.venueBot).toMatchObject({
      presentationMode: 'CHARACTER',
      characterKey: 'tochi',
      tonePreset: 'friendly',
      responseDepth: 'BALANCED',
    })
    expect(JSON.stringify(result.manifest.aiConfiguration.venueBot)).not.toMatch(
      /tenant|storage|workflow|asset|revision/iu,
    )
    expect(result.readiness.omissions.map(({ code }) => code)).not.toContain(
      'VENUE_BOT_CONFIGURATION_UNAVAILABLE',
    )
  })

  it('uses canonical JSON/hash and stable ordering for the same caller envelope', async () => {
    const h = harness()
    const first = await projectFullVenueDeploymentManifest(envelope, h.client as never)
    const second = await projectFullVenueDeploymentManifest(envelope, h.client as never)

    expect(first.canonicalJson).toBe(canonicalDeploymentManifest(first.manifest))
    expect(first.manifestHash).toBe(deploymentManifestHash(first.manifest))
    expect(second.canonicalJson).toBe(first.canonicalJson)
    expect(second.manifestHash).toBe(first.manifestHash)
    expect(first.readiness.omissions.map(({ code }) => code)).toEqual(
      [...first.readiness.omissions.map(({ code }) => code)].sort(),
    )
  })

  it('omits URLs, private instructions, model references and generalized content truthfully', async () => {
    const h = harness({ aiGuideNotes: 'never select this private instruction' })
    const result = await projectFullVenueDeploymentManifest(envelope, h.client as never)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('secret-logo')
    expect(serialized).not.toContain('never select this private instruction')
    expect(result.manifest.aiConfiguration.modelReferences).toEqual([])
    expect(result.manifest.capabilities.enabled).toEqual([])
    expect(result.readiness.omissions.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'CAPABILITY_PUBLICATION_UNAVAILABLE',
        'GENERALIZED_CONTENT_PUBLICATION_UNAVAILABLE',
        'IMMUTABLE_ASSET_PUBLICATION_UNAVAILABLE',
        'MODEL_REFERENCE_PUBLICATION_UNAVAILABLE',
        'READINESS_REFERENCE_UNAVAILABLE',
        'URL_BRANDING_ASSETS_OMITTED',
      ]),
    )
  })

  it('rejects malformed caller identity before database access', async () => {
    const h = harness()
    await expect(
      projectFullVenueDeploymentManifest(
        { ...envelope, manifestId: 'not-a-uuid' },
        h.client as never,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    } satisfies Partial<FullManifestProjectionError>)
    expect(h.findFirst).not.toHaveBeenCalled()
  })

  it('fails closed for cross-scope and unsafe legacy venue state without reflecting values', async () => {
    const missing = harness()
    missing.findFirst.mockResolvedValue(null)
    await expect(
      projectFullVenueDeploymentManifest(envelope, missing.client as never),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    const unsafeName = 'sensitive-'.repeat(100)
    const unsafe = harness({ name: unsafeName })
    let failure: unknown
    try {
      await projectFullVenueDeploymentManifest(envelope, unsafe.client as never)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'INVALID_STATE' })
    expect(JSON.stringify(failure)).not.toContain(unsafeName)
  })
})
