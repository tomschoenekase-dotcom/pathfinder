import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readControl, setControl, readProviderControl, setProviderControl } = vi.hoisted(() => ({
  readControl: vi.fn(),
  setControl: vi.fn(),
  readProviderControl: vi.fn(),
  setProviderControl: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  db: {},
  GlobalAiControlActionError: class GlobalAiControlActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  AiProviderHealthControlActionError: class AiProviderHealthControlActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  readGlobalAiControl: readControl,
  setGlobalAiControlAction: setControl,
  readAiProviderHealthControl: readProviderControl,
  setAiProviderHealthOverrideAction: setProviderControl,
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
  readControl.mockResolvedValue(state())
  readProviderControl.mockResolvedValue({
    schemaVersion: 1,
    overrides: [],
    activeUnhealthyProviders: [],
    configured: false,
    malformed: false,
    updatedAt: null,
    updatedBy: null,
  })
  setControl.mockResolvedValue(
    state({
      paused: true,
      reason: 'Provider incident',
      configured: true,
      updatedAt: revision,
      updatedBy: 'admin_1',
      replayed: false,
    }),
  )
  setProviderControl.mockResolvedValue({
    schemaVersion: 1,
    overrides: [
      {
        provider: 'anthropic',
        reason: 'Provider incident',
        expiresAt: new Date('2026-08-23T20:00:00.000Z'),
        active: true,
      },
    ],
    activeUnhealthyProviders: ['anthropic'],
    configured: true,
    malformed: false,
    updatedAt: revision,
    updatedBy: 'admin_1',
    replayed: false,
  })
})

describe('platform global AI incident control router', () => {
  it('requires platform-admin authorization for reads and writes', async () => {
    const caller = app.createCaller(context(false))
    await expect(caller.admin.getGlobalAiControl()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller.admin.getAiProviderHealthControl()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      caller.admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      caller.admin.setAiProviderHealthOverride({
        provider: 'anthropic',
        unhealthy: true,
        reason: 'Provider incident',
        expiresAt: new Date('2026-08-23T20:00:00.000Z'),
        expectedUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(readControl).not.toHaveBeenCalled()
    expect(setControl).not.toHaveBeenCalled()
    expect(readProviderControl).not.toHaveBeenCalled()
    expect(setProviderControl).not.toHaveBeenCalled()
  })

  it('reads provider health state without mutating it', async () => {
    await expect(
      app.createCaller(context(true)).admin.getAiProviderHealthControl(),
    ).resolves.toMatchObject({ activeUnhealthyProviders: [] })
    expect(readProviderControl).toHaveBeenCalledWith(expect.anything())
    expect(setProviderControl).not.toHaveBeenCalled()
  })

  it('delegates an expiring provider override with the human platform-admin actor', async () => {
    const expiresAt = new Date('2026-08-23T20:00:00.000Z')
    await app.createCaller(context(true)).admin.setAiProviderHealthOverride({
      provider: 'anthropic',
      unhealthy: true,
      reason: '  Provider incident  ',
      expiresAt,
      expectedUpdatedAt: revision,
    })
    expect(setProviderControl).toHaveBeenCalledWith(
      {
        provider: 'anthropic',
        unhealthy: true,
        reason: 'Provider incident',
        expiresAt,
        expectedUpdatedAt: revision,
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
  })

  it('rejects provider exclusion without expiry and maps domain conflicts', async () => {
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.setAiProviderHealthOverride({
        provider: 'anthropic',
        unhealthy: true,
        reason: 'Provider incident',
        expiresAt: null,
        expectedUpdatedAt: null,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(setProviderControl).not.toHaveBeenCalled()

    const { AiProviderHealthControlActionError } = await import('@pathfinder/db')
    setProviderControl.mockRejectedValueOnce(
      new AiProviderHealthControlActionError('CONFLICT', 'opaque'),
    )
    await expect(
      caller.admin.setAiProviderHealthOverride({
        provider: 'anthropic',
        unhealthy: false,
        reason: 'Provider recovered',
        expiresAt: null,
        expectedUpdatedAt: revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('returns the typed state without mutating it', async () => {
    await expect(app.createCaller(context(true)).admin.getGlobalAiControl()).resolves.toEqual(
      state(),
    )
    expect(readControl).toHaveBeenCalledWith(expect.anything())
    expect(setControl).not.toHaveBeenCalled()
  })

  it('delegates normalized input and the session-derived human platform-admin actor', async () => {
    const result = await app.createCaller(context(true)).admin.setGlobalAiControl({
      paused: true,
      reason: '  Provider incident  ',
      expectedUpdatedAt: revision,
    })

    expect(setControl).toHaveBeenCalledWith(
      {
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
        actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      },
      expect.anything(),
    )
    expect(result).toMatchObject({ paused: true, replayed: false })
  })

  it('maps domain conflicts and invalid input to stable public errors', async () => {
    const { GlobalAiControlActionError } = await import('@pathfinder/db')
    setControl.mockRejectedValueOnce(
      new GlobalAiControlActionError(
        'CONFLICT',
        'Global AI control changed; refresh and try again.',
      ),
    )
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    setControl.mockRejectedValueOnce(
      new GlobalAiControlActionError('INVALID_INPUT', 'Invalid control input.'),
    )
    await expect(
      caller.admin.setGlobalAiControl({
        paused: true,
        reason: 'Provider incident',
        expectedUpdatedAt: revision,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
