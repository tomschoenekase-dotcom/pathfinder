import { describe, expect, it } from 'vitest'

import {
  IncompatibleContentSnapshotError,
  knowledgeSnapshotData,
  operationalUpdateSnapshotData,
  placeSnapshotData,
} from './content-history-snapshots'

const provenance = {
  sourceType: 'DIRECT',
  authorship: 'HUMAN',
  sourceName: null,
  sourceUrl: null,
  importedAt: null,
  humanConfirmedAt: null,
  humanConfirmedBy: null,
  lastReviewedAt: null,
  lastReviewedBy: null,
  sourcePackageId: null,
}

describe('content history snapshot boundary', () => {
  it('rejects valid-shaped snapshots with a foreign tenant, venue, or entity identity', () => {
    const snapshot = {
      id: 'place_1',
      tenantId: 'tenant_other',
      venueId: 'venue_1',
      name: 'Place',
      type: 'exhibit',
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
    }
    expect(() =>
      placeSnapshotData(snapshot, 1, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityId: 'place_1',
      }),
    ).toThrow(IncompatibleContentSnapshotError)
  })

  it('rejects unknown fields rather than silently restoring a future schema', () => {
    expect(() =>
      knowledgeSnapshotData(
        {
          id: 'knowledge_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          title: 'Title',
          category: 'FAQ',
          content: 'Content',
          isEnabled: true,
          unexpected: 'future-field',
        },
        1,
        { tenantId: 'tenant_1', venueId: 'venue_1', entityId: 'knowledge_1' },
      ),
    ).toThrow(IncompatibleContentSnapshotError)
  })

  it('restores direct provenance only for schema version 2', () => {
    const snapshot = {
      id: 'knowledge_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      title: 'Title',
      category: 'FAQ',
      content: 'Content',
      isEnabled: true,
      ...provenance,
    }
    const restored = knowledgeSnapshotData(snapshot, 2, {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      entityId: 'knowledge_1',
    })
    expect(restored.mutable).toMatchObject({ sourceType: 'DIRECT', authorship: 'HUMAN' })
    expect(() =>
      knowledgeSnapshotData(snapshot, 1, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        entityId: 'knowledge_1',
      }),
    ).toThrow(IncompatibleContentSnapshotError)
  })

  it('coerces historical operational timestamps but preserves exact parent scope', () => {
    const restored = operationalUpdateSnapshotData(
      {
        id: 'update_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        placeId: null,
        updateType: 'GENERAL_NOTICE',
        severity: 'INFO',
        priority: 'NORMAL',
        title: 'Notice',
        body: null,
        redirectTo: null,
        startsAt: '2026-08-11T10:00:00.000Z',
        expiresAt: '2026-08-11T11:00:00.000Z',
        status: 'DRAFT',
        isActive: true,
        createdBy: 'actor_1',
        publishedBy: null,
        publishedAt: null,
        createdAt: '2026-08-11T09:00:00.000Z',
      },
      { tenantId: 'tenant_1', entityId: 'update_1' },
    )
    expect(restored.snapshot.startsAt).toBeInstanceOf(Date)
    expect(restored.mutable.venueId).toBe('venue_1')
  })
})
