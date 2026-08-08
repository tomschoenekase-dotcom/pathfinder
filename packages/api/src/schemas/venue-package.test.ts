import { describe, expect, it } from 'vitest'

import {
  canonicalVenuePackagePayload,
  VENUE_PACKAGE_ITEM_LIMIT,
  VenuePackageAppliedEntities,
  VenuePackagePayload,
  VenuePackagePayloadV1,
  VenuePackagePayloadV2,
  VenuePackageSemanticDuplicateScan,
  VenuePackageStoredPreview,
} from './venue-package'

const knowledge = (index: number) => ({
  title: `Entry ${index}`,
  category: 'FAQ',
  content: `Content ${index}`,
  isEnabled: true,
})

describe('venue package schema', () => {
  it('preserves strict frozen V1 parsing and rejects unsupported versions and fields', () => {
    expect(
      VenuePackagePayload.safeParse({ places: [], knowledgeEntries: [knowledge(1)] }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 3,
        places: [],
        knowledgeEntries: [knowledge(1)],
      }).success,
    ).toBe(false)
    const unsupported = VenuePackagePayload.safeParse({
      schemaVersion: 1,
      places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0, audience: 'members' }],
      knowledgeEntries: [{ ...knowledge(1), audience: 'members' }],
      tours: [],
    })
    expect(unsupported.success).toBe(false)
    if (!unsupported.success) {
      expect(unsupported.error.issues.map((issue) => issue.path.join('.'))).toEqual(
        expect.arrayContaining(['', 'places.0', 'knowledgeEntries.0']),
      )
      expect(unsupported.error.issues.every((issue) => issue.message.length > 0)).toBe(true)
    }

    expect(
      VenuePackagePayloadV1.safeParse({
        schemaVersion: 2,
        venue: { guideNotes: null },
        places: [],
        knowledgeEntries: [],
      }).success,
    ).toBe(false)
  })

  it('accepts strict V2 venue patches with omission as no-change and null as clear', () => {
    const parsed = VenuePackagePayloadV2.parse({
      schemaVersion: 2,
      venue: {
        identity: { name: 'Riverside Museum', description: null },
        guideNotes: null,
        branding: {
          chatTheme: null,
          chatAccentColor: '#3A7BD5',
          chatFont: null,
          chatLogoUrl: null,
          chatBannerUrl: 'https://cdn.example.com/banner.png',
        },
        aiBehavior: {
          aiGuideNotes: null,
          aiTone: null,
          aiGuideName: null,
        },
      },
    })

    expect(parsed.places).toEqual([])
    expect(parsed.knowledgeEntries).toEqual([])
    expect(parsed.venue?.identity).not.toHaveProperty('category')
    expect(parsed.venue?.identity?.description).toBeNull()
    expect(parsed.venue?.guideNotes).toBeNull()

    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        venue: { branding: { chatAccentColor: 'blue' } },
      }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        venue: { branding: { chatLogoUrl: 'not-a-url' } },
      }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        venue: { aiBehavior: { aiTone: 'SARCASTIC' } },
      }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        venue: { identity: { name: 'Venue', slug: 'not-supported' } },
      }).success,
    ).toBe(false)
  })

  it('rejects empty V2 operations and empty nested patch objects', () => {
    for (const input of [
      { schemaVersion: 2 },
      { schemaVersion: 2, places: [], knowledgeEntries: [] },
      { schemaVersion: 2, venue: {} },
      { schemaVersion: 2, venue: { identity: {} } },
      { schemaVersion: 2, venue: { branding: {} } },
      { schemaVersion: 2, venue: { aiBehavior: {} } },
    ]) {
      expect(VenuePackagePayload.safeParse(input).success).toBe(false)
    }

    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
        places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0 }],
      }).success,
    ).toBe(true)
  })

  it('enforces one shared 500-item bound', () => {
    for (const schemaVersion of [1, 2] as const) {
      const result = VenuePackagePayload.safeParse({
        schemaVersion,
        places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0 }],
        knowledgeEntries: Array.from({ length: VENUE_PACKAGE_ITEM_LIMIT }, (_, index) =>
          knowledge(index),
        ),
      })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.message.includes('at most 500'))).toBe(
          true,
        )
      }
    }
  })

  it('canonicalizes deterministically and binds the venue', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [knowledge(1)],
    })
    expect(canonicalVenuePackagePayload('venue_a', payload)).toBe(
      canonicalVenuePackagePayload('venue_a', payload),
    )
    expect(canonicalVenuePackagePayload('venue_a', payload)).not.toBe(
      canonicalVenuePackagePayload('venue_b', payload),
    )

    const omitted = VenuePackagePayload.parse({
      schemaVersion: 2,
      venue: { identity: { name: 'Riverside' } },
    })
    const cleared = VenuePackagePayload.parse({
      schemaVersion: 2,
      venue: { identity: { name: 'Riverside', description: null } },
    })
    expect(canonicalVenuePackagePayload('venue_a', omitted)).toBe(
      canonicalVenuePackagePayload('venue_a', omitted),
    )
    expect(canonicalVenuePackagePayload('venue_a', omitted)).not.toBe(
      canonicalVenuePackagePayload('venue_a', cleared),
    )
    expect(canonicalVenuePackagePayload('venue_a', omitted)).not.toBe(
      canonicalVenuePackagePayload('venue_b', omitted),
    )
  })

  it('requires complete semantic scans to cover every input and existing item', () => {
    const scope = {
      embeddingProfile: 'test-profile',
      inputCount: 1,
      scannedInputCount: 1,
      existingCount: 2,
      scannedExistingCount: 2,
    }
    expect(
      VenuePackageSemanticDuplicateScan.safeParse({
        status: 'COMPLETE',
        similarityThreshold: 0.86,
        scopes: { places: scope, knowledgeEntries: scope },
      }).success,
    ).toBe(true)
    expect(
      VenuePackageSemanticDuplicateScan.safeParse({
        status: 'COMPLETE',
        similarityThreshold: 0.86,
        scopes: {
          places: { ...scope, scannedExistingCount: 1 },
          knowledgeEntries: scope,
        },
      }).success,
    ).toBe(false)
    expect(
      VenuePackageSemanticDuplicateScan.safeParse({
        status: 'NOT_RUN',
        similarityThreshold: 0.86,
        scopes: { places: scope, knowledgeEntries: scope },
      }).success,
    ).toBe(false)
  })

  it('strictly validates persisted preview evidence', () => {
    const payload = VenuePackagePayload.parse({
      schemaVersion: 1,
      places: [],
      knowledgeEntries: [knowledge(1)],
    })
    const scope = {
      embeddingProfile: 'test-profile',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    }
    const preview = {
      schemaVersion: 1,
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      warningDigest: 'c'.repeat(64),
      mode: 'ADDITIVE_V1',
      report: {
        errors: [],
        warnings: [],
        semanticDuplicateScan: {
          status: 'COMPLETE',
          similarityThreshold: 0.86,
          scopes: {
            places: scope,
            knowledgeEntries: { ...scope, inputCount: 1, scannedInputCount: 1 },
          },
        },
      },
      changes: {
        places: { add: [], change: [], remove: [], unchanged: 0 },
        knowledgeEntries: { add: payload.knowledgeEntries, change: [], remove: [], unchanged: 0 },
      },
    }
    expect(VenuePackageStoredPreview.safeParse(preview).success).toBe(true)
    expect(VenuePackageStoredPreview.safeParse({ ...preview, providerResponse: {} }).success).toBe(
      false,
    )
    expect(
      VenuePackageStoredPreview.safeParse({
        ...preview,
        changes: {
          ...preview.changes,
          places: { ...preview.changes.places, change: [{ id: 'unsupported' }] },
        },
      }).success,
    ).toBe(false)

    const venueSnapshot = {
      name: 'Riverside',
      description: 'x'.repeat(1_001),
      category: 'museum',
      guideNotes: null,
      chatTheme: 'legacy-custom-theme',
      chatAccentColor: 'legacy-blue',
      chatFont: 'legacy-font',
      chatLogoUrl: 'legacy-relative-logo.png',
      chatBannerUrl: null,
      aiGuideNotes: null,
      aiTone: 'FRIENDLY',
      aiGuideName: null,
    }
    const v2Preview = {
      ...preview,
      schemaVersion: 2,
      mode: 'CONFIG_PATCH_AND_ADDITIVE_V2',
      changes: {
        ...preview.changes,
        venue: {
          change: [
            {
              path: 'venue.identity.description',
              before: 'Old description',
              after: null,
            },
          ],
          unchanged: 11,
        },
      },
    }
    expect(VenuePackageStoredPreview.safeParse(v2Preview).success).toBe(true)
    expect(
      VenuePackageStoredPreview.safeParse({
        ...v2Preview,
        mode: 'ADDITIVE_V1',
      }).success,
    ).toBe(false)
    expect(
      VenuePackageStoredPreview.safeParse({
        ...v2Preview,
        changes: {
          ...v2Preview.changes,
          venue: {
            change: [
              {
                path: 'venue.branding.chatLogoUrl',
                before: 'legacy-relative-logo.png',
                after: 'still-not-a-url',
              },
            ],
            unchanged: 11,
          },
        },
      }).success,
    ).toBe(false)
    expect(
      VenuePackageStoredPreview.safeParse({
        ...v2Preview,
        changes: {
          ...v2Preview.changes,
          venue: {
            change: [{ path: 'venue.slug', before: 'old', after: 'new' }],
            unchanged: 11,
          },
        },
      }).success,
    ).toBe(false)

    const v1Manifest = {
      postApplyDigest: 'd'.repeat(64),
      places: [],
      knowledgeEntries: [],
    }
    const v2Manifest = {
      schemaVersion: 2,
      postApplyDigest: 'd'.repeat(64),
      venue: { before: venueSnapshot, after: { ...venueSnapshot, description: null } },
      places: [],
      knowledgeEntries: [],
    }
    expect(VenuePackageAppliedEntities.safeParse(v1Manifest).success).toBe(true)
    expect(VenuePackageAppliedEntities.safeParse(v2Manifest).success).toBe(true)
    expect(VenuePackageAppliedEntities.safeParse({ ...v2Manifest, schemaVersion: 1 }).success).toBe(
      false,
    )
  })
})
