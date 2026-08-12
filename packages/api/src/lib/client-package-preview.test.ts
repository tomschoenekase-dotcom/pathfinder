import { describe, expect, it } from 'vitest'
import {
  ClientPackagePreviewProjectionError,
  clientPackagePreviewProjection,
} from './client-package-preview'

const scan = {
  status: 'COMPLETE' as const,
  similarityThreshold: 0.9,
  scopes: {
    places: {
      embeddingProfile: 'x',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    },
    knowledgeEntries: {
      embeddingProfile: 'x',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    },
  },
}
const venue = {
  id: 'venue_1',
  name: 'Old',
  description: null,
  category: null,
  chatTheme: null,
  chatAccentColor: null,
  chatFont: null,
  chatLogoUrl: null,
  chatBannerUrl: null,
  aiGuideName: null,
  aiTone: null,
  tonePreset: 'friendly',
  tonePresetVersion: 1,
}
const row = (index: number) => ({
  id: `place_${index}`,
  name: `Place ${String(index).padStart(3, '0')}`,
  type: 'room',
  shortDescription: null,
  longDescription: null,
  areaName: null,
  hours: null,
  photoUrl: null,
  lat: null,
  lng: null,
  tags: [],
  isActive: true,
})
const additive = (count: number) =>
  ({
    schemaVersion: 1,
    payloadHash: 'a'.repeat(64),
    baseDigest: 'b'.repeat(64),
    warningDigest: 'c'.repeat(64),
    mode: 'ADDITIVE_V1',
    report: { errors: [], warnings: [], semanticDuplicateScan: scan },
    changes: {
      places: {
        add: Array.from({ length: count }, (_, index) => ({
          name: `Added ${index}`,
          type: 'room',
          tags: [],
          importanceScore: 0,
        })),
        change: [],
        remove: [],
        unchanged: 0,
      },
      knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
    },
  }) as never

describe('effective client package preview projection', () => {
  it.each(['concise', 'informative', 'enthusiastic'] as const)(
    'preserves exact public %s tone preset and behavior version',
    (tonePreset) => {
      const result = clientPackagePreviewProjection({
        venue: { ...venue, tonePreset, tonePresetVersion: 1 },
        places: [],
        knowledgeEntries: [],
        pkg: { id: 'package_1', approvedAt: new Date('2030-01-01') },
        stored: additive(0),
      })
      expect(result.venue.guide.tone).toEqual({ preset: tonePreset, behaviorVersion: 1 })
    },
  )

  it.each([
    [500, 1],
    [400, 200],
  ])('fails with a controlled content limit for base %s plus %s additions', (base, added) => {
    expect(() =>
      clientPackagePreviewProjection({
        venue,
        places: Array.from({ length: base }, (_, index) => row(index)),
        knowledgeEntries: [],
        pkg: { id: 'package_1', approvedAt: new Date('2030-01-01') },
        stored: additive(added),
      }),
    ).toThrowError(ClientPackagePreviewProjectionError)
  })

  it.each([1, 2] as const)(
    'projects additive V%s content over the existing base',
    (schemaVersion) => {
      const result = clientPackagePreviewProjection({
        venue,
        places: [
          {
            id: 'base',
            name: 'Base room',
            type: 'room',
            shortDescription: null,
            longDescription: null,
            areaName: null,
            hours: null,
            photoUrl: null,
            lat: null,
            lng: null,
            tags: [],
            isActive: true,
          },
        ],
        knowledgeEntries: [],
        pkg: { id: 'package_1', approvedAt: new Date('2030-01-01') },
        stored: {
          schemaVersion,
          payloadHash: 'a'.repeat(64),
          baseDigest: 'b'.repeat(64),
          warningDigest: 'c'.repeat(64),
          mode: schemaVersion === 1 ? 'ADDITIVE_V1' : 'ADDITIVE_V2',
          report: { errors: [], warnings: [], semanticDuplicateScan: scan },
          changes: {
            ...(schemaVersion === 2
              ? {
                  venue: {
                    change: [
                      { path: 'venue.branding.chatTheme', before: null, after: 'light' },
                      {
                        path: 'venue.aiBehavior.tonePreset',
                        before: 'friendly',
                        after: 'concise',
                      },
                    ],
                    unchanged: 0,
                  },
                }
              : {}),
            places: {
              add: [{ name: 'Added room', type: 'room', tags: [], importanceScore: 0 }],
              change: [],
              remove: [],
              unchanged: 1,
            },
            knowledgeEntries: {
              add: [{ title: 'Welcome', category: 'general', content: 'Hello' }],
              change: [],
              remove: [],
              unchanged: 0,
            },
          },
        } as never,
      })
      expect(result.experience.places.map(({ name }) => name)).toEqual(['Added room', 'Base room'])
      expect(result.experience.knowledgeEntries).toEqual([
        { title: 'Welcome', category: 'general', content: 'Hello' },
      ])
      expect(result.venue.branding.theme).toBe(schemaVersion === 2 ? 'light' : null)
      expect(result.venue.guide.tone.preset).toBe(schemaVersion === 2 ? 'concise' : 'friendly')
    },
  )

  it('is deterministic across base and additive input permutations', () => {
    const stored = {
      schemaVersion: 1,
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      warningDigest: 'c'.repeat(64),
      mode: 'ADDITIVE_V1',
      report: { errors: [], warnings: [], semanticDuplicateScan: scan },
      changes: {
        places: {
          add: [
            { name: 'Zed', type: 'room', tags: ['b'], importanceScore: 0 },
            { name: 'Alpha', type: 'room', tags: ['a'], importanceScore: 0 },
          ],
          change: [],
          remove: [],
          unchanged: 0,
        },
        knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
      },
    } as never
    const base = {
      venue,
      places: [],
      knowledgeEntries: [],
      pkg: { id: 'package_1', approvedAt: new Date('2030-01-01') },
    }
    const left = clientPackagePreviewProjection({ ...base, stored })
    const reversed = {
      ...(stored as object),
      changes: {
        ...(stored as { changes: object }).changes,
        places: {
          ...(stored as { changes: { places: { add: unknown[] } } }).changes.places,
          add: [
            ...(stored as { changes: { places: { add: unknown[] } } }).changes.places.add,
          ].reverse(),
        },
      },
    } as never
    expect(clientPackagePreviewProjection({ ...base, stored: reversed })).toEqual(left)
  })

  it('applies V3 update/delete/create and filters inactive content without mechanics leakage', () => {
    const result = clientPackagePreviewProjection({
      venue,
      places: [
        {
          id: 'place_keep',
          name: 'Old',
          type: 'room',
          shortDescription: null,
          longDescription: null,
          areaName: null,
          hours: null,
          photoUrl: null,
          lat: null,
          lng: null,
          tags: [],
          isActive: true,
        },
        {
          id: 'place_remove',
          name: 'Remove',
          type: 'room',
          shortDescription: null,
          longDescription: null,
          areaName: null,
          hours: null,
          photoUrl: null,
          lat: null,
          lng: null,
          tags: [],
          isActive: true,
        },
      ],
      knowledgeEntries: [],
      pkg: { id: 'package_1', approvedAt: new Date('2030-01-01') },
      stored: {
        schemaVersion: 3,
        payloadHash: 'a'.repeat(64),
        baseDigest: 'b'.repeat(64),
        warningDigest: 'c'.repeat(64),
        mode: 'MUTATING_V3',
        report: { errors: [], warnings: [], semanticDuplicateScan: scan },
        changes: {
          venue: {
            expectedVersionId: null,
            change: [
              {
                path: 'venue.aiBehavior.tonePreset',
                before: 'friendly',
                after: 'enthusiastic',
              },
            ],
            unchanged: 0,
          },
          places: {
            add: [],
            change: [
              {
                itemKey: crypto.randomUUID(),
                id: 'place_keep',
                expectedVersionId: crypto.randomUUID(),
                before: {
                  id: 'place_keep',
                  name: 'Old',
                  type: 'room',
                  itemType: null,
                  shortDescription: null,
                  longDescription: null,
                  lat: null,
                  lng: null,
                  tags: [],
                  importanceScore: 0,
                  areaName: null,
                  hours: null,
                  photoUrl: null,
                  isActive: true,
                },
                after: {
                  name: 'New',
                  type: 'room',
                  itemType: null,
                  shortDescription: null,
                  longDescription: null,
                  lat: null,
                  lng: null,
                  tags: [],
                  importanceScore: 0,
                  areaName: null,
                  hours: null,
                  photoUrl: null,
                  isActive: true,
                },
              },
            ],
            remove: [
              {
                itemKey: crypto.randomUUID(),
                id: 'place_remove',
                expectedVersionId: crypto.randomUUID(),
                before: {
                  id: 'place_remove',
                  name: 'Remove',
                  type: 'room',
                  itemType: null,
                  shortDescription: null,
                  longDescription: null,
                  lat: null,
                  lng: null,
                  tags: [],
                  importanceScore: 0,
                  areaName: null,
                  hours: null,
                  photoUrl: null,
                  isActive: true,
                },
                dependencies: [],
              },
            ],
            unchanged: 0,
          },
          knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
        },
      },
    })
    expect(result.experience.places.map(({ name }) => name)).toEqual(['New'])
    expect(result.venue.guide.tone).toEqual({ preset: 'enthusiastic', behaviorVersion: 1 })
    expect(JSON.stringify(result)).not.toMatch(
      /itemKey|schemaVersion|payloadHash|baseDigest|before|after|report|provenance|aiTone|guideNotes/iu,
    )
    expect(JSON.stringify(result.experience)).not.toMatch(/"id"/u)
  })
})
