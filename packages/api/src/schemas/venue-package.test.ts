import { describe, expect, it } from 'vitest'

import {
  canonicalVenuePackagePayload,
  VENUE_PACKAGE_ITEM_LIMIT,
  VenuePackagePayload,
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
  it('requires schemaVersion 1 and rejects unsupported root and nested fields', () => {
    expect(
      VenuePackagePayload.safeParse({ places: [], knowledgeEntries: [knowledge(1)] }).success,
    ).toBe(false)
    expect(
      VenuePackagePayload.safeParse({
        schemaVersion: 2,
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
  })

  it('enforces one shared 500-item bound', () => {
    const result = VenuePackagePayload.safeParse({
      schemaVersion: 1,
      places: [{ name: 'Lobby', type: 'room', tags: [], importanceScore: 0 }],
      knowledgeEntries: Array.from({ length: VENUE_PACKAGE_ITEM_LIMIT }, (_, index) =>
        knowledge(index),
      ),
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('at most 500'))).toBe(true)
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
  })
})
