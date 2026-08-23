import { describe, expect, it, vi } from 'vitest'

import {
  AiProviderHealthControlReadError,
  readActiveUnhealthyAiProviders,
  readAiProviderHealthControl,
  setAiProviderHealthOverrideAction,
} from './ai-provider-health-control'

const now = new Date('2026-08-22T20:00:00.000Z')
const revision = new Date('2026-08-22T19:00:00.000Z')
const expiry = new Date('2099-08-23T20:00:00.000Z')
const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }

function readClient(row: unknown) {
  return { platformConfig: { findUnique: vi.fn().mockResolvedValue(row) } }
}

describe('AI provider health control reads', () => {
  it('defaults to no exclusions when no override row exists', async () => {
    await expect(readAiProviderHealthControl(readClient(null) as never, now)).resolves.toEqual({
      schemaVersion: 1,
      overrides: [],
      activeUnhealthyProviders: [],
      configured: false,
      malformed: false,
      updatedAt: null,
      updatedBy: null,
    })
  })

  it('distinguishes active and expired overrides without deleting history', async () => {
    const client = readClient({
      value: {
        schemaVersion: 1,
        overrides: [
          { provider: 'anthropic', reason: 'Provider incident', expiresAt: expiry.toISOString() },
          {
            provider: 'openai',
            reason: 'Expired investigation',
            expiresAt: '2026-08-22T18:00:00.000Z',
          },
        ],
      },
      updatedAt: revision,
      updatedBy: 'admin-old',
    })
    const state = await readAiProviderHealthControl(client as never, now)
    expect(state.activeUnhealthyProviders).toEqual(['anthropic'])
    expect(state.overrides).toEqual([
      expect.objectContaining({ provider: 'anthropic', active: true, expiresAt: expiry }),
      expect.objectContaining({ provider: 'openai', active: false }),
    ])
  })

  it('fails routing closed for malformed or unreadable control state', async () => {
    await expect(
      readActiveUnhealthyAiProviders(
        readClient({
          value: { schemaVersion: 1, overrides: [{ provider: 'unknown' }] },
          updatedAt: revision,
          updatedBy: 'admin-old',
        }) as never,
        now,
      ),
    ).rejects.toEqual(new AiProviderHealthControlReadError('control-malformed'))

    await expect(
      readActiveUnhealthyAiProviders(
        {
          platformConfig: {
            findUnique: vi.fn().mockRejectedValue(new Error('database unavailable')),
          },
        } as never,
        now,
      ),
    ).rejects.toEqual(new AiProviderHealthControlReadError('control-unavailable'))
  })
})

function actionHarness(row: unknown = null) {
  const findUnique = vi.fn().mockResolvedValue(row)
  const create = vi.fn().mockResolvedValue({})
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
  return { client: { $transaction: transaction }, transaction, create, updateMany, auditCreate }
}

function actionInput(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'anthropic' as const,
    unhealthy: true,
    reason: 'Provider incident',
    expiresAt: expiry,
    expectedUpdatedAt: null,
    actor,
    ...overrides,
  }
}

describe('setAiProviderHealthOverrideAction', () => {
  it('requires exact human authority, a known provider, reason, and future expiry', async () => {
    const h = actionHarness()
    for (const overrides of [
      { actor: { ...actor, type: 'SYSTEM' } },
      { provider: 'unknown' },
      { reason: ' ' },
      { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
      { expiresAt: null },
      { expectedUpdatedAt: new Date('invalid') },
    ]) {
      await expect(
        setAiProviderHealthOverrideAction(actionInput(overrides) as never, h.client as never),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('creates an expiring exclusion and strict audit evidence atomically', async () => {
    const h = actionHarness()
    const result = await setAiProviderHealthOverrideAction(actionInput(), h.client as never)

    expect(h.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'ai-provider-health-control-v1',
        value: {
          schemaVersion: 1,
          overrides: [
            {
              provider: 'anthropic',
              reason: 'Provider incident',
              expiresAt: expiry.toISOString(),
            },
          ],
        },
        updatedBy: 'admin-1',
      }),
    })
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'admin-1',
        actorRole: 'PLATFORM_ADMIN',
        actorType: 'HUMAN',
        action: 'admin.ai-provider.marked-unhealthy',
        targetType: 'PlatformConfig',
        targetId: 'ai-provider-health-control-v1',
        afterState: expect.objectContaining({
          provider: 'anthropic',
          unhealthy: true,
          expiresAt: expiry.toISOString(),
        }),
      }),
    })
    expect(result).toMatchObject({
      activeUnhealthyProviders: ['anthropic'],
      replayed: false,
    })
  })

  it('restores one provider without erasing another and uses exact CAS', async () => {
    const h = actionHarness({
      value: {
        schemaVersion: 1,
        overrides: [
          { provider: 'anthropic', reason: 'Text issue', expiresAt: expiry.toISOString() },
          { provider: 'openai', reason: 'Embedding issue', expiresAt: expiry.toISOString() },
        ],
      },
      updatedAt: revision,
      updatedBy: 'admin-old',
    })
    const result = await setAiProviderHealthOverrideAction(
      actionInput({
        unhealthy: false,
        reason: 'Anthropic recovered',
        expiresAt: null,
        expectedUpdatedAt: revision,
      }),
      h.client as never,
    )

    expect(h.updateMany).toHaveBeenCalledWith({
      where: { key: 'ai-provider-health-control-v1', updatedAt: revision },
      data: expect.objectContaining({
        value: {
          schemaVersion: 1,
          overrides: [
            { provider: 'openai', reason: 'Embedding issue', expiresAt: expiry.toISOString() },
          ],
        },
      }),
    })
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'admin.ai-provider.restored' }),
    })
    expect(result.activeUnhealthyProviders).toEqual(['openai'])
  })

  it('rejects stale revisions and makes audit failure fatal', async () => {
    const row = {
      value: { schemaVersion: 1, overrides: [] },
      updatedAt: revision,
      updatedBy: 'admin-old',
    }
    const stale = actionHarness(row)
    await expect(
      setAiProviderHealthOverrideAction(actionInput(), stale.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(stale.auditCreate).not.toHaveBeenCalled()

    const auditFailure = actionHarness()
    auditFailure.auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      setAiProviderHealthOverrideAction(actionInput(), auditFailure.client as never),
    ).rejects.toThrow('audit unavailable')
  })
})
