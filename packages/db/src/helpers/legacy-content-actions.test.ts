import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LegacyContentActionError,
  retireLegacyKnowledgeAction,
  updateLegacyPlaceAction,
} from './legacy-content-actions'

const updatedAt = new Date('2026-08-11T20:00:00.000Z')
const place = {
  id: 'place-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  name: 'Lobby',
  type: 'place',
  itemType: null,
  shortDescription: 'body',
  longDescription: 'long body',
  lat: null,
  lng: null,
  tags: [],
  importanceScore: 1,
  areaName: null,
  hours: null,
  photoUrl: 'https://secret.example/raw',
  isActive: true,
  createdAt: updatedAt,
  updatedAt,
}
const knowledge = {
  id: 'knowledge-1',
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  title: 'Policy',
  category: 'FAQ',
  content: 'private body',
  isEnabled: true,
  createdAt: updatedAt,
  updatedAt,
}

function client() {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => []),
    venue: { findFirst: vi.fn(async () => ({ id: 'venue-1' })) },
    place: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(place)
        .mockResolvedValueOnce({
          ...place,
          name: 'Updated',
          updatedAt: new Date(updatedAt.getTime() + 1),
        }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    venueKnowledgeEntry: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce(knowledge)
        .mockResolvedValueOnce({
          ...knowledge,
          isEnabled: false,
          updatedAt: new Date(updatedAt.getTime() + 1),
        }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: {
      create: vi.fn(async (input: unknown) => {
        void input
        return {}
      }),
    },
  }
  return { tx, db: { $transaction: vi.fn(async (callback) => callback(tx)) } }
}

describe('legacy content actions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('locks exact place scope, requires updatedAt CAS count=1, and audits no bodies or URLs', async () => {
    const { tx, db } = client()
    await updateLegacyPlaceAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        id: 'place-1',
        expectedUpdatedAt: updatedAt,
        actor: { type: 'HUMAN', id: 'manager-1', role: 'MANAGER' },
        fields: { name: 'Updated' },
      },
      db as never,
    )
    expect(tx.place.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'place-1', tenantId: 'tenant-1', venueId: 'venue-1', updatedAt },
      }),
    )
    const audit = tx.auditLog.create.mock.calls[0]![0]
    expect(JSON.stringify(audit)).not.toContain('body')
    expect(JSON.stringify(audit)).not.toContain('secret.example')
  })

  it('returns conflict and does not audit when exact CAS changes zero rows', async () => {
    const { tx, db } = client()
    tx.place.updateMany.mockResolvedValueOnce({ count: 0 })
    await expect(
      updateLegacyPlaceAction(
        {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          id: 'place-1',
          expectedUpdatedAt: updatedAt,
          actor: { type: 'HUMAN', id: 'manager-1', role: 'MANAGER' },
          fields: { name: 'Updated' },
        },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' } satisfies Partial<LegacyContentActionError>)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('soft-retires knowledge instead of deleting it and emits sanitized same-tx audit', async () => {
    const { tx, db } = client()
    await retireLegacyKnowledgeAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        id: 'knowledge-1',
        expectedUpdatedAt: updatedAt,
        actor: { type: 'HUMAN', id: 'owner-1', role: 'OWNER' },
      },
      db as never,
    )
    expect(tx.venueKnowledgeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isEnabled: false } }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'knowledge.retired' }) }),
    )
    expect(JSON.stringify(tx.auditLog.create.mock.calls[0])).not.toContain('private body')
  })

  it('accepts an explicit human platform administrator without weakening scope or audit attribution', async () => {
    const { tx, db } = client()
    await updateLegacyPlaceAction(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        id: 'place-1',
        expectedUpdatedAt: updatedAt,
        actor: { type: 'HUMAN', id: 'platform-admin-1', role: 'PLATFORM_ADMIN' },
        fields: { name: 'Updated' },
      },
      db as never,
    )
    expect(tx.place.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
      }),
    )
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorId: 'platform-admin-1',
          actorRole: 'PLATFORM_ADMIN',
        }),
      }),
    )
  })
})
