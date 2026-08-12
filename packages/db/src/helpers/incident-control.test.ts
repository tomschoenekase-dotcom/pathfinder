import { describe, expect, it, vi } from 'vitest'

import {
  assertGlobalAiAvailable,
  GlobalAiAdmissionError,
  readGlobalAiControl,
  setGlobalAiControlAction,
} from './incident-control'

function client(row: unknown) {
  return {
    platformConfig: {
      findUnique: vi.fn().mockResolvedValue(row),
    },
  }
}

describe('global AI incident control', () => {
  it('keeps the rollout active when the versioned row is absent', async () => {
    const testClient = client(null)
    await expect(readGlobalAiControl(testClient as never)).resolves.toEqual({
      schemaVersion: 1,
      paused: false,
      reason: null,
      configured: false,
      malformed: false,
      updatedAt: null,
      updatedBy: null,
    })
    await expect(assertGlobalAiAvailable(testClient as never)).resolves.toBeUndefined()
  })

  it('reads an exact configured state and denies a pause', async () => {
    const updatedAt = new Date('2026-08-08T20:00:00.000Z')
    const testClient = client({
      value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
      updatedAt,
      updatedBy: 'admin_1',
    })
    await expect(readGlobalAiControl(testClient as never)).resolves.toMatchObject({
      paused: true,
      reason: 'Provider incident',
      configured: true,
      malformed: false,
      updatedAt,
      updatedBy: 'admin_1',
    })
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toMatchObject({
      name: 'GlobalAiAdmissionError',
      code: 'global-ai-paused',
    })
  })

  it('fails closed on malformed stored JSON', async () => {
    const testClient = client({
      value: { paused: false },
      updatedAt: new Date('2026-08-08T20:00:00.000Z'),
      updatedBy: 'admin_1',
    })
    const state = await readGlobalAiControl(testClient as never)
    expect(state).toMatchObject({ paused: true, configured: true, malformed: true, reason: null })
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toBeInstanceOf(
      GlobalAiAdmissionError,
    )
  })

  it('propagates read failures so callers can fail closed', async () => {
    const testClient = {
      platformConfig: { findUnique: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    }
    await expect(assertGlobalAiAvailable(testClient as never)).rejects.toMatchObject({
      name: 'GlobalAiAdmissionError',
      code: 'global-ai-control-unavailable',
    })
  })
})

const revision = new Date('2026-08-08T20:00:00.000Z')
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function actionHarness(row: unknown = null) {
  const findUnique = vi.fn().mockResolvedValue(row)
  const create = vi.fn().mockResolvedValue({ key: 'global-ai-control-v1' })
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' })
  const transactionClient = {
    platformConfig: { findUnique, create, updateMany },
    auditLog: { create: auditCreate },
  }
  const transaction = vi.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  )
  return {
    client: { $transaction: transaction },
    transaction,
    findUnique,
    create,
    updateMany,
    auditCreate,
  }
}

function actionInput(overrides: Record<string, unknown> = {}) {
  return {
    paused: true,
    reason: 'Provider incident',
    expectedUpdatedAt: null,
    actor,
    ...overrides,
  }
}

describe('setGlobalAiControlAction', () => {
  it('rejects non-human/non-admin authority, invalid revisions, and invalid reasons before DB access', async () => {
    const h = actionHarness()
    for (const overrides of [
      { actor: { ...actor, type: 'SYSTEM' } },
      { actor: { ...actor, role: 'OWNER' } },
      { actor: { ...actor, id: ' ' } },
      { expectedUpdatedAt: new Date('invalid') },
      { reason: ' ' },
      { reason: 'x'.repeat(501) },
    ]) {
      await expect(
        setGlobalAiControlAction(actionInput(overrides) as never, h.client as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('atomically creates the first configured pause with a strict sanitized audit', async () => {
    const h = actionHarness()
    const result = await setGlobalAiControlAction(actionInput(), h.client as never)

    expect(h.create).toHaveBeenCalledWith({
      data: {
        key: 'global-ai-control-v1',
        value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
        updatedBy: 'admin-1',
        updatedAt: expect.any(Date),
      },
    })
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.global-ai.paused',
        targetType: 'PlatformConfig',
        targetId: 'global-ai-control-v1',
        beforeState: { paused: false, reason: null, malformed: false },
        afterState: { paused: true, reason: 'Provider incident', malformed: false },
      },
    })
    expect(result).toMatchObject({ paused: true, configured: true, replayed: false })
  })

  it('updates only the exact stored revision and records a resume in the same transaction', async () => {
    const h = actionHarness({
      value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
      updatedAt: revision,
      updatedBy: 'admin-old',
    })
    const result = await setGlobalAiControlAction(
      actionInput({
        paused: false,
        reason: 'Provider recovered',
        expectedUpdatedAt: revision,
      }),
      h.client as never,
    )
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { key: 'global-ai-control-v1', updatedAt: revision },
      data: {
        value: { schemaVersion: 1, paused: false, reason: 'Provider recovered' },
        updatedBy: 'admin-1',
        updatedAt: expect.any(Date),
      },
    })
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.global-ai.resumed' }),
    })
    expect(result).toMatchObject({ paused: false, reason: 'Provider recovered', replayed: false })
  })

  it('rejects stale, missing, and lost CAS revisions without audit', async () => {
    const stored = {
      value: { schemaVersion: 1, paused: false, reason: 'Normal' },
      updatedAt: revision,
      updatedBy: 'admin-old',
    }
    for (const expectedUpdatedAt of [null, new Date('2026-08-08T19:59:59.000Z')]) {
      const h = actionHarness(stored)
      await expect(
        setGlobalAiControlAction(actionInput({ expectedUpdatedAt }), h.client as never),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(h.updateMany).not.toHaveBeenCalled()
      expect(h.auditCreate).not.toHaveBeenCalled()
    }

    const lost = actionHarness(stored)
    lost.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      setGlobalAiControlAction(actionInput({ expectedUpdatedAt: revision }), lost.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(lost.auditCreate).not.toHaveBeenCalled()
  })

  it('replays an exact requested state without a write or duplicate audit', async () => {
    const h = actionHarness({
      value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
      updatedAt: revision,
      updatedBy: 'admin-old',
    })
    await expect(
      setGlobalAiControlAction(actionInput({ expectedUpdatedAt: revision }), h.client as never),
    ).resolves.toMatchObject({ paused: true, replayed: true, updatedBy: 'admin-old' })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it('repairs malformed state as an explicit pause and retains fail-closed before evidence', async () => {
    const h = actionHarness({
      value: { paused: false },
      updatedAt: revision,
      updatedBy: 'admin-old',
    })
    await setGlobalAiControlAction(
      actionInput({ reason: 'Repair malformed state', expectedUpdatedAt: revision }),
      h.client as never,
    )
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeState: { paused: true, reason: null, malformed: true },
        afterState: { paused: true, reason: 'Repair malformed state', malformed: false },
      }),
    })
  })

  it('maps concurrent first-create identity loss to conflict and makes audit failure fatal', async () => {
    const collision = actionHarness()
    collision.create.mockRejectedValue({ code: 'P2002' })
    await expect(
      setGlobalAiControlAction(actionInput(), collision.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(collision.auditCreate).not.toHaveBeenCalled()

    const auditFailure = actionHarness()
    auditFailure.auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      setGlobalAiControlAction(actionInput(), auditFailure.client as never),
    ).rejects.toThrow('audit unavailable')
  })
})
