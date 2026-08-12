import { describe, expect, it, vi } from 'vitest'

import type { VenuePackagePayloadV3 } from '../schemas/venue-package'
import { applyVenuePackageV3ContentEffects } from './venue-package-v3-content-effects'

const provenance = { sourceType: 'curated-notes', contentOrigin: 'HUMAN_AUTHORED' as const }

function payload(): VenuePackagePayloadV3 {
  return {
    schemaVersion: 3,
    places: {
      create: [
        {
          itemKey: 'place-create',
          provenance,
          value: { name: 'New place', type: 'gallery', tags: [], importanceScore: 10 },
        },
      ],
      update: [
        {
          itemKey: 'place-update',
          provenance,
          id: 'place-1',
          value: {
            name: 'Updated place',
            type: 'gallery',
            itemType: null,
            shortDescription: null,
            longDescription: null,
            lat: null,
            lng: null,
            tags: [],
            importanceScore: 20,
            areaName: null,
            hours: null,
            photoUrl: null,
            isActive: true,
          },
        },
      ],
      delete: [{ itemKey: 'place-delete', provenance, id: 'place-2' }],
    },
    knowledgeEntries: {
      create: [
        {
          itemKey: 'knowledge-create',
          provenance,
          value: { title: 'New entry', category: 'FAQ', content: 'Content', isEnabled: true },
        },
      ],
      update: [
        {
          itemKey: 'knowledge-update',
          provenance,
          id: 'knowledge-1',
          value: {
            title: 'Updated entry',
            category: 'FAQ',
            content: 'Updated',
            isEnabled: true,
          },
        },
      ],
      delete: [{ itemKey: 'knowledge-delete', provenance, id: 'knowledge-2' }],
    },
  }
}

describe('venue package V3 content effects', () => {
  it('preserves operation order, exact tenant scope, provenance, and recorded identities', async () => {
    const calls: string[] = []
    const db = {
      place: {
        create: vi.fn(async () => ({ id: 'created-place' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      venueKnowledgeEntry: {
        create: vi.fn(async () => ({ id: 'created-knowledge' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    }
    const establishContext = vi.fn(async (itemKey: string) => {
      calls.push(`context:${itemKey}`)
    })
    const record = vi.fn(async (effect: { itemKey: string }) => {
      calls.push(`record:${effect.itemKey}`)
    })
    const importedAt = new Date('2026-08-11T12:00:00.000Z')
    const approvedAt = new Date('2026-08-11T11:00:00.000Z')
    const provenanceData = vi.fn(() => ({
      sourceType: 'curated-notes',
      authorship: 'HUMAN_AUTHORED' as const,
      sourceName: null,
      sourceUrl: null,
      importedAt,
      humanConfirmedAt: approvedAt,
      humanConfirmedBy: 'owner-1',
      lastReviewedAt: approvedAt,
      lastReviewedBy: 'owner-1',
      sourcePackageId: 'package-1',
    }))

    await applyVenuePackageV3ContentEffects({
      db: db as never,
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      packageId: 'package-1',
      approvedAt,
      approvedBy: 'owner-1',
      importedAt,
      payload: payload(),
      establishContext,
      provenanceData,
      record,
      conflict: (message) => {
        throw new Error(message)
      },
    })

    expect(calls).toEqual([
      'context:place-create',
      'record:place-create',
      'context:place-update',
      'record:place-update',
      'context:place-delete',
      'record:place-delete',
      'context:knowledge-create',
      'record:knowledge-create',
      'context:knowledge-update',
      'record:knowledge-update',
      'context:knowledge-delete',
      'record:knowledge-delete',
    ])
    expect(db.place.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'place-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      }),
    )
    expect(db.venueKnowledgeEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: 'knowledge-2', tenantId: 'tenant-1', venueId: 'venue-1' },
    })
    expect(record).toHaveBeenCalledWith({
      itemKey: 'place-create',
      entityType: 'PLACE',
      entityId: 'created-place',
      operation: 'CREATE',
    })
    expect(provenanceData).toHaveBeenCalledTimes(4)
  })

  it('fails closed before recording when an exact-scope mutation misses', async () => {
    const record = vi.fn()
    const db = {
      place: {
        create: vi.fn(async () => ({ id: 'created-place' })),
        updateMany: vi.fn(async () => ({ count: 0 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      venueKnowledgeEntry: {
        create: vi.fn(async () => ({ id: 'created-knowledge' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    }
    const conflict = vi.fn((message: string): never => {
      throw new Error(message)
    })

    await expect(
      applyVenuePackageV3ContentEffects({
        db: db as never,
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        packageId: 'package-1',
        approvedAt: new Date(),
        approvedBy: 'owner-1',
        importedAt: new Date(),
        payload: { ...payload(), places: { ...payload().places, create: [] } },
        establishContext: async () => undefined,
        provenanceData: () => ({
          sourceType: 'curated-notes',
          authorship: 'HUMAN_AUTHORED',
          sourceName: null,
          sourceUrl: null,
          importedAt: new Date(),
          humanConfirmedAt: new Date(),
          humanConfirmedBy: 'owner-1',
          lastReviewedAt: new Date(),
          lastReviewedBy: 'owner-1',
          sourcePackageId: 'package-1',
        }),
        record,
        conflict,
      }),
    ).rejects.toThrow('Place changed during package application')
    expect(conflict).toHaveBeenCalledOnce()
    expect(record).not.toHaveBeenCalled()
  })
})
