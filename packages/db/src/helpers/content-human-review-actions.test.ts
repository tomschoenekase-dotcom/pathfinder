import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  confirmContentCurrentAction,
  ContentHumanReviewError,
  type ContentHumanReviewClient,
} from './content-human-review-actions'

const expectedUpdatedAt = new Date('2026-08-10T10:00:00.000Z')
const reviewedAt = new Date('2026-08-11T14:30:00.000Z')

function fixture() {
  const row = {
    id: 'place_1',
    updatedAt: expectedUpdatedAt,
    lastReviewedAt: null,
    lastReviewedBy: null,
    humanConfirmedAt: null,
    humanConfirmedBy: null,
    sourceType: 'UNKNOWN',
    sourceName: null,
    sourceUrl: null,
  }
  const tx = {
    place: {
      findFirst: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    venueKnowledgeEntry: {
      findFirst: vi.fn().mockResolvedValue({ ...row, id: 'knowledge_1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
  }
  const client = {
    $transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
  } as unknown as ContentHumanReviewClient
  return { tx, client }
}

const common = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  entityType: 'PLACE' as const,
  entityId: 'place_1',
  expectedUpdatedAt,
  conclusion: 'CONFIRMED_CURRENT' as const,
  explicitlyConfirmedCurrent: true as const,
  actor: { type: 'HUMAN' as const, id: 'operator_1', role: 'PLATFORM_ADMIN' as const },
  now: reviewedAt,
}

describe('confirmContentCurrentAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires a human platform administrator before opening a transaction', async () => {
    const { client } = fixture()
    await expect(
      confirmContentCurrentAction({
        ...common,
        db: client,
        actor: { type: 'HUMAN', id: '', role: 'PLATFORM_ADMIN' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('confirms an exact active Place with CAS and repairs only validated provenance', async () => {
    const { tx, client } = fixture()
    const result = await confirmContentCurrentAction({
      ...common,
      db: client,
      provenanceRepair: {
        sourceType: 'DOCUMENT',
        sourceName: 'Operations guide',
        sourceUrl: 'https://example.test/guide',
      },
    })

    expect(tx.place.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'place_1', tenantId: 'tenant_1', venueId: 'venue_1', isActive: true },
      }),
    )
    expect(tx.place.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'place_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        isActive: true,
        updatedAt: expectedUpdatedAt,
      },
      data: {
        lastReviewedAt: reviewedAt,
        lastReviewedBy: 'operator_1',
        humanConfirmedAt: reviewedAt,
        humanConfirmedBy: 'operator_1',
        updatedAt: reviewedAt,
        sourceType: 'DOCUMENT',
        sourceName: 'Operations guide',
        sourceUrl: 'https://example.test/guide',
      },
    })
    expect(result).toMatchObject({
      conclusion: 'CONFIRMED_CURRENT',
      repairedFields: ['sourceType', 'sourceName', 'sourceUrl'],
    })
    const update = tx.place.updateMany.mock.calls[0]?.[0]
    expect(update.data).not.toHaveProperty('name')
    expect(update.data).not.toHaveProperty('shortDescription')
    expect(update.data).not.toHaveProperty('isActive')
  })

  it('uses the same exact scope and CAS for a knowledge entry', async () => {
    const { tx, client } = fixture()
    await confirmContentCurrentAction({
      ...common,
      db: client,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: 'knowledge_1',
    })
    expect(tx.venueKnowledgeEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'knowledge_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          isEnabled: true,
          updatedAt: expectedUpdatedAt,
        },
      }),
    )
    expect(tx.place.updateMany).not.toHaveBeenCalled()
  })

  it('fails closed on stale CAS or failed strict audit', async () => {
    const stale = fixture()
    stale.tx.place.updateMany.mockResolvedValue({ count: 0 })
    await expect(confirmContentCurrentAction({ ...common, db: stale.client })).rejects.toEqual(
      new ContentHumanReviewError('CONFLICT', 'Content changed; refresh before reviewing.'),
    )
    expect(stale.tx.auditLog.create).not.toHaveBeenCalled()

    const auditFailure = fixture()
    auditFailure.tx.auditLog.create.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      confirmContentCurrentAction({ ...common, db: auditFailure.client }),
    ).rejects.toThrow('audit unavailable')
  })

  it('keeps content and raw source URLs out of strict audit evidence', async () => {
    const { tx, client } = fixture()
    await confirmContentCurrentAction({
      ...common,
      db: client,
      provenanceRepair: { sourceUrl: 'https://example.test/reference?section=arrival' },
    })
    const audit = tx.auditLog.create.mock.calls[0]?.[0]
    expect(JSON.stringify(audit)).not.toContain('https://')
    expect(JSON.stringify(audit)).not.toContain('section=arrival')
    expect(JSON.stringify(audit)).not.toContain('shortDescription')
    expect(audit.data.afterState).toMatchObject({ repairedFields: ['sourceUrl'] })
  })

  it('rejects implicit confirmation and unsafe provenance before mutation', async () => {
    const { client } = fixture()
    await expect(
      confirmContentCurrentAction({
        ...common,
        db: client,
        explicitlyConfirmedCurrent: false as true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      confirmContentCurrentAction({
        ...common,
        db: client,
        provenanceRepair: { sourceUrl: 'https://user:secret@example.test/guide' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    for (const sourceUrl of [
      'https://example.test/guide?token=secret',
      'https://example.test/guide?apiKey=secret',
      'https://example.test/guide#auth=secret',
      'https://example.test/guide?x-amz-signature=secret',
      'https://example.test/guide?x-goog-credential=secret',
      'https://example.test/guide?section=arrival%20details',
    ]) {
      await expect(
        confirmContentCurrentAction({
          ...common,
          db: client,
          provenanceRepair: { sourceUrl },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
