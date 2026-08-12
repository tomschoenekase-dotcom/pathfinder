import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeAudit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: writeAudit }))

import { ContentHistoryActionError, revertContentHistoryAction } from './content-history-actions'

const tenantId = 'tenant_1'
const venueId = 'venue_1'
const targetId = '11111111-1111-4111-8111-111111111111'
const latestId = '22222222-2222-4222-8222-222222222222'
const appliedId = '33333333-3333-4333-8333-333333333333'

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: targetId,
    sequence: 1n,
    tenantId,
    venueId,
    entityType: 'PLACE',
    entityId: 'place_1',
    operation: 'UPDATE',
    beforeState: null,
    afterState: null,
    actorId: 'prior_actor',
    revertedFromId: null,
    snapshotSchemaVersion: 1,
    createdAt: new Date('2026-08-11T00:00:00.000Z'),
    ...overrides,
  }
}

function harness(
  options: {
    target?: ReturnType<typeof version> | null
    latest?: { id: string } | null
    applied?: ReturnType<typeof version> | null
    currentPlace?: { id: string; venueId: string } | null
  } = {},
) {
  const findVersion = vi
    .fn()
    .mockResolvedValueOnce(options.target === undefined ? version() : options.target)
    .mockResolvedValueOnce(options.latest === undefined ? { id: latestId } : options.latest)
    .mockResolvedValueOnce(
      options.applied === undefined ? version({ id: appliedId, sequence: 2n }) : options.applied,
    )
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    contentVersion: { findFirst: findVersion },
    venue: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    place: {
      findFirst: vi.fn().mockResolvedValue(options.currentPlace ?? { id: 'place_1', venueId }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    venueKnowledgeEntry: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    operationalUpdate: {
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  }
  return {
    tx,
    client: { $transaction: vi.fn(async (callback) => callback(tx)) },
  }
}

const baseInput = {
  tenantId,
  versionId: targetId,
  expectedCurrentVersionId: latestId,
  snapshotSide: 'AFTER' as const,
  actor: { type: 'HUMAN' as const, id: 'actor_1', role: 'MANAGER' as const },
}

describe('content history canonical action', () => {
  beforeEach(() => {
    writeAudit.mockReset().mockResolvedValue(undefined)
  })

  it('fails closed before mutation or audit when the target belongs to another tenant', async () => {
    const { client, tx } = harness({ target: null })
    await expect(revertContentHistoryAction(baseInput, client as never)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(tx.place.deleteMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
    expect(tx.contentVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: targetId, tenantId } }),
    )
  })

  it('rejects stale latest-version CAS after locks and before content mutation', async () => {
    const { client, tx } = harness({ latest: { id: 'stale_version' } })
    await expect(revertContentHistoryAction(baseInput, client as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(tx.$executeRaw).toHaveBeenCalled()
    expect(tx.place.deleteMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('requires a human owner for venue deletion or restoration', async () => {
    const { client, tx } = harness({
      target: version({ entityType: 'VENUE', entityId: venueId }),
    })
    tx.venue.findFirst.mockResolvedValue({ id: venueId })
    await expect(revertContentHistoryAction(baseInput, client as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('reverts exact scoped content and writes only version/scope audit evidence', async () => {
    const { client, tx } = harness()
    const result = await revertContentHistoryAction(baseInput, client as never)
    expect(result.id).toBe(appliedId)
    expect(tx.place.deleteMany).toHaveBeenCalledWith({
      where: { id: 'place_1', tenantId },
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        actorId: 'actor_1',
        actorRole: 'MANAGER',
        action: 'content-history.reverted',
        targetType: 'PLACE',
        targetId: 'place_1',
        beforeState: { versionId: latestId, venueId },
        afterState: {
          versionId: appliedId,
          revertedFromId: targetId,
          snapshotSide: 'AFTER',
          venueId,
        },
      }),
      tx,
    )
    expect(JSON.stringify(writeAudit.mock.calls)).not.toContain('secret content')
  })

  it('propagates strict audit failure so the enclosing transaction cannot report success', async () => {
    const { client } = harness()
    writeAudit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(revertContentHistoryAction(baseInput, client as never)).rejects.toThrow(
      'audit unavailable',
    )
  })

  it('maps unique and foreign-key restoration failures to stable conflicts', async () => {
    for (const code of ['P2002', 'P2003']) {
      const client = {
        $transaction: vi.fn().mockRejectedValue({ code }),
      }
      await expect(revertContentHistoryAction(baseInput, client as never)).rejects.toEqual(
        expect.objectContaining({ code: 'CONFLICT' }),
      )
    }
  })

  it('rejects a non-human actor before opening a transaction', async () => {
    const { client } = harness()
    await expect(
      revertContentHistoryAction(
        { ...baseInput, actor: { type: 'AGENT', id: 'agent_1', role: 'MANAGER' } as never },
        client as never,
      ),
    ).rejects.toBeInstanceOf(ContentHistoryActionError)
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
