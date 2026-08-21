import { describe, expect, it, vi } from 'vitest'

import {
  prepareWeeklyDigestIntentAction,
  WeeklyDigestIntentActionError,
} from './weekly-digest-intent-actions'

const weekStart = new Date('2026-08-03T00:00:00.000Z')
const weekEnd = new Date('2026-08-09T23:59:59.999Z')
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function client() {
  const tx = {
    tenant: { findUnique: vi.fn().mockResolvedValue({ id: 'tenant-1' }) },
    weeklyDigest: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  return { tx, db: { $transaction: vi.fn(async (work) => work(tx)) } }
}

describe('prepareWeeklyDigestIntentAction', () => {
  it('creates durable PENDING intent and sanitized strict audit atomically', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique.mockResolvedValue(null)
    tx.weeklyDigest.create.mockResolvedValue({ id: 'digest-1', status: 'PENDING', weekEnd })

    const result = await prepareWeeklyDigestIntentAction(
      { tenantId: 'tenant-1', weekStart, weekEnd, actor },
      db as never,
    )

    expect(result).toMatchObject({
      id: 'digest-1',
      status: 'PENDING',
      enqueueAllowed: true,
      outcome: 'CREATED',
    })
    expect(tx.weeklyDigest.create).toHaveBeenCalledWith({
      data: { tenantId: 'tenant-1', weekStart, weekEnd, status: 'PENDING' },
      select: { id: true, status: true, weekEnd: true },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        actorType: 'HUMAN',
        action: 'weekly-digest.requested',
        targetType: 'WeeklyDigest',
        targetId: 'digest-1',
        afterState: {
          weekStart: weekStart.toISOString(),
          weekEnd: weekEnd.toISOString(),
          status: 'PENDING',
        },
      },
    })
  })

  it.each([
    ['PENDING', true],
    ['PROCESSING', false],
    ['COMPLETE', false],
  ] as const)('replays %s truthfully with enqueueAllowed=%s', async (status, enqueueAllowed) => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique.mockResolvedValue({ id: 'digest-1', status, weekEnd })

    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).resolves.toMatchObject({ status, enqueueAllowed, outcome: 'REPLAYED' })
    expect(tx.weeklyDigest.create).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('resets FAILED state with exact CAS and strict audit', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique.mockResolvedValue({ id: 'digest-1', status: 'FAILED', weekEnd })
    tx.weeklyDigest.updateMany.mockResolvedValue({ count: 1 })

    const result = await prepareWeeklyDigestIntentAction(
      {
        tenantId: 'tenant-1',
        weekStart,
        weekEnd,
        actor: { type: 'SYSTEM', id: 'weekly-digest-scheduler', role: 'SYSTEM' },
      },
      db as never,
    )

    expect(result).toMatchObject({ status: 'PENDING', enqueueAllowed: true, outcome: 'RESET' })
    expect(tx.weeklyDigest.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'digest-1',
        tenantId: 'tenant-1',
        status: 'FAILED',
        weekEnd,
      },
      data: {
        status: 'PENDING',
        weekEnd,
        sessionCount: 0,
        messageCount: 0,
        insights: [],
        generatedAt: null,
      },
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorRole: 'SYSTEM',
          action: 'weekly-digest.retry-requested',
          beforeState: { status: 'FAILED' },
          afterState: { status: 'PENDING' },
        }),
      }),
    )
  })

  it('reconciles a lost FAILED CAS without overwriting the winner', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique
      .mockResolvedValueOnce({ id: 'digest-1', status: 'FAILED', weekEnd })
      .mockResolvedValueOnce({ id: 'digest-1', status: 'PROCESSING', weekEnd })
    tx.weeklyDigest.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).resolves.toMatchObject({
      status: 'PROCESSING',
      enqueueAllowed: false,
      outcome: 'RACED',
    })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('rejects a lost FAILED CAS when the winning boundary differs', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique
      .mockResolvedValueOnce({ id: 'digest-1', status: 'FAILED', weekEnd })
      .mockResolvedValueOnce({
        id: 'digest-1',
        status: 'PENDING',
        weekEnd: new Date('2026-08-10T00:00:00.000Z'),
      })
    tx.weeklyDigest.updateMany.mockResolvedValue({ count: 0 })

    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it('retries a concurrent natural-key create collision as an exact replay', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'digest-1', status: 'PENDING', weekEnd })
    tx.weeklyDigest.create.mockRejectedValueOnce({ code: 'P2002' })

    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).resolves.toMatchObject({ id: 'digest-1', enqueueAllowed: true, outcome: 'REPLAYED' })
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })

  it('rejects missing tenant, conflicting week end, invalid ranges and forged actors', async () => {
    const { db, tx } = client()
    tx.tenant.findUnique.mockResolvedValueOnce(null)
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'missing', weekStart, weekEnd, actor },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<WeeklyDigestIntentActionError>)

    tx.weeklyDigest.findUnique.mockResolvedValueOnce({
      id: 'digest-1',
      status: 'PENDING',
      weekEnd: new Date('2026-08-10T00:00:00.000Z'),
    })
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const invalidDb = client().db
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart: weekEnd, weekEnd: weekStart, actor },
        invalidDb as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor: undefined } as never,
        invalidDb as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      prepareWeeklyDigestIntentAction(
        {
          tenantId: 'tenant-1',
          weekStart,
          weekEnd,
          actor: { type: 'SYSTEM', id: '', role: 'SYSTEM' },
        },
        invalidDb as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      prepareWeeklyDigestIntentAction(
        {
          tenantId: 'tenant-1',
          weekStart,
          weekEnd,
          actor: { type: 'SYSTEM', id: 'some-other-worker', role: 'SYSTEM' },
        },
        invalidDb as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart: 'not-a-date', weekEnd, actor } as never,
        invalidDb as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(invalidDb.$transaction).not.toHaveBeenCalled()
  })

  it('fails closed when strict audit persistence fails', async () => {
    const { db, tx } = client()
    tx.weeklyDigest.findUnique.mockResolvedValue(null)
    tx.weeklyDigest.create.mockResolvedValue({ id: 'digest-1', status: 'PENDING', weekEnd })
    tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      prepareWeeklyDigestIntentAction(
        { tenantId: 'tenant-1', weekStart, weekEnd, actor },
        db as never,
      ),
    ).rejects.toThrow('audit unavailable')
  })
})
