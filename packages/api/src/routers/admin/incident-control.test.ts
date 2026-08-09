import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createConfig, updateConfig, readControl, writeAudit, transaction } = vi.hoisted(() => ({
  createConfig: vi.fn(),
  updateConfig: vi.fn(),
  readControl: vi.fn(),
  writeAudit: vi.fn(),
  transaction: vi.fn(),
}))

const transactionClient = {
  platformConfig: {
    create: createConfig,
    updateMany: updateConfig,
  },
}

vi.mock('@pathfinder/db', () => ({
  db: {
    $transaction: (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      transaction(callback, transactionClient),
  },
  readGlobalAiControl: readControl,
  writeAuditLogStrict: writeAudit,
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminIncidentControlRouter } from './incident-control'

const app = router({ admin: adminIncidentControlRouter })
const revision = new Date('2026-08-08T20:00:00.000Z')

function context(isPlatformAdmin: boolean): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    paused: false,
    reason: null,
    configured: false,
    malformed: false,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  transaction.mockImplementation(
    async (callback: (client: typeof transactionClient) => Promise<unknown>, client) =>
      callback(client),
  )
  createConfig.mockResolvedValue({ key: 'global-ai-control-v1' })
  updateConfig.mockResolvedValue({ count: 1 })
  writeAudit.mockResolvedValue(undefined)
})

describe('platform global AI incident control', () => {
  it('requires platform-admin authorization for reads and writes', async () => {
    const caller = app.createCaller(context(false))
    await expect(caller.admin.getGlobalAiControl()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(readControl).not.toHaveBeenCalled()
  })

  it('returns the typed state without mutating it', async () => {
    readControl.mockResolvedValue(state())
    await expect(app.createCaller(context(true)).admin.getGlobalAiControl()).resolves.toEqual(
      state(),
    )
    expect(transaction).not.toHaveBeenCalled()
  })

  it('creates the first paused state and strict audit atomically', async () => {
    readControl.mockResolvedValue(state())
    const result = await app.createCaller(context(true)).admin.setGlobalAiControl({
      paused: true,
      reason: 'Provider incident',
      expectedUpdatedAt: null,
    })

    expect(createConfig).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'global-ai-control-v1',
        value: { schemaVersion: 1, paused: true, reason: 'Provider incident' },
        updatedBy: 'admin_1',
        updatedAt: expect.any(Date),
      }),
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin_1',
        action: 'admin.global-ai.paused',
        beforeState: { paused: false, reason: null, malformed: false },
        afterState: { paused: true, reason: 'Provider incident', malformed: false },
      }),
      transactionClient,
    )
    expect(result).toMatchObject({ paused: true, configured: true, replayed: false })
  })

  it('updates only the exact revision and records a resume reason', async () => {
    readControl.mockResolvedValue(
      state({
        paused: true,
        reason: 'Provider incident',
        configured: true,
        updatedAt: revision,
        updatedBy: 'admin_1',
      }),
    )
    const result = await app.createCaller(context(true)).admin.setGlobalAiControl({
      paused: false,
      reason: 'Provider recovered',
      expectedUpdatedAt: revision,
    })

    expect(updateConfig).toHaveBeenCalledWith({
      where: { key: 'global-ai-control-v1', updatedAt: revision },
      data: expect.objectContaining({
        value: { schemaVersion: 1, paused: false, reason: 'Provider recovered' },
        updatedBy: 'admin_1',
      }),
    })
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.global-ai.resumed' }),
      transactionClient,
    )
    expect(result).toMatchObject({ paused: false, reason: 'Provider recovered', replayed: false })
  })

  it('rejects stale or missing revisions before audit', async () => {
    readControl.mockResolvedValue(state({ configured: true, updatedAt: revision }))
    await expect(
      app.createCaller(context(true)).admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(updateConfig).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('rejects a lost update and propagates strict audit failure', async () => {
    readControl.mockResolvedValue(state({ configured: true, updatedAt: revision }))
    updateConfig.mockResolvedValueOnce({ count: 0 })
    await expect(
      app.createCaller(context(true)).admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(writeAudit).not.toHaveBeenCalled()

    updateConfig.mockResolvedValueOnce({ count: 1 })
    writeAudit.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(
      app.createCaller(context(true)).admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
      }),
    ).rejects.toThrow('audit unavailable')
  })

  it('replays an exact state without writes or duplicate audit', async () => {
    readControl.mockResolvedValue(
      state({
        paused: true,
        reason: 'Provider incident',
        configured: true,
        updatedAt: revision,
      }),
    )
    await expect(
      app.createCaller(context(true)).admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
      }),
    ).resolves.toMatchObject({ paused: true, replayed: true })
    expect(createConfig).not.toHaveBeenCalled()
    expect(updateConfig).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('maps a concurrent first-create collision to a conflict', async () => {
    readControl.mockResolvedValue(state())
    createConfig.mockRejectedValueOnce({ code: 'P2002' })
    await expect(
      app.createCaller(context(true)).admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: null,
      }),
    ).rejects.toBeInstanceOf(TRPCError)
  })
})
