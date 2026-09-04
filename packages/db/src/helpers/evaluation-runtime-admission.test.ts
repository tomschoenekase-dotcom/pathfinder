import { describe, expect, it, vi } from 'vitest'

import {
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY,
  evaluationRuntimeAuthorizationAllowsRun,
  getEvaluationRuntimeAuthorization,
  isEvaluationRuntimeDurablyEnabled,
} from './evaluation-runtime-admission'

describe('evaluation runtime durable admission', () => {
  const now = new Date('2026-09-04T17:00:00.000Z')
  const active = {
    version: 3,
    enabled: true,
    authorizationId: '865ec669-825c-44e1-b09d-a5db8323c1ba',
    tenantId: 'tenant-1',
    authorizedAt: '2026-09-04T16:55:00.000Z',
    expiresAt: '2099-09-04T17:30:00.000Z',
    maxBudgetE8Usd: '105000000',
    allowedProviders: ['openai'],
  }

  it('requires an unexpired exact durable authorization contract', async () => {
    const findUnique = vi.fn().mockResolvedValue({ value: active })
    await expect(
      getEvaluationRuntimeAuthorization({ platformConfig: { findUnique } } as never, now),
    ).resolves.toEqual({
      version: 3,
      enabled: true,
      authorizationId: active.authorizationId,
      tenantId: active.tenantId,
      authorizedAt: new Date(active.authorizedAt),
      expiresAt: new Date(active.expiresAt),
      maxBudgetE8Usd: 105000000n,
      allowedProviders: ['openai'],
    })
    await expect(
      isEvaluationRuntimeDurablyEnabled({ platformConfig: { findUnique } } as never),
    ).resolves.toBe(true)
    expect(findUnique).toHaveBeenCalledWith({
      where: { key: EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY },
      select: { value: true },
    })
  })

  it.each([
    null,
    {},
    { version: 1, enabled: true },
    { ...active, version: 2 },
    { ...active, tenantId: '' },
    { ...active, enabled: false },
    { ...active, authorizationId: 'not-a-uuid' },
    { ...active, maxBudgetE8Usd: '-1' },
    { ...active, maxBudgetE8Usd: '0' },
    { ...active, maxBudgetE8Usd: '410000001' },
    { ...active, allowedProviders: [] },
    { ...active, allowedProviders: ['openai', 'openai'] },
    { ...active, allowedProviders: ['other'] },
    { ...active, authorizedAt: '2099-09-04T16:55:00.000Z' },
    { ...active, expiresAt: '2026-09-04T16:54:00.000Z' },
  ])('fails closed for %j', async (value) => {
    const client = { platformConfig: { findUnique: vi.fn().mockResolvedValue({ value }) } }
    await expect(getEvaluationRuntimeAuthorization(client as never, now)).resolves.toBeNull()
  })

  it('fails closed when durable state cannot be read', async () => {
    const client = {
      platformConfig: { findUnique: vi.fn().mockRejectedValue(new Error('unavailable')) },
    }
    await expect(isEvaluationRuntimeDurablyEnabled(client as never)).resolves.toBe(false)
  })

  it('admits only a run frozen under the same active provider authorization window', async () => {
    const client = {
      platformConfig: { findUnique: vi.fn().mockResolvedValue({ value: active }) },
    }
    const snapshot = {
      authorization: {
        authorizationId: active.authorizationId,
        tenantId: active.tenantId,
        authorizedAt: active.authorizedAt,
        expiresAt: active.expiresAt,
        maxBudgetE8Usd: active.maxBudgetE8Usd,
        allowedProviders: ['openai'],
      },
    }
    await expect(
      evaluationRuntimeAuthorizationAllowsRun(snapshot, 'tenant-1', 'openai', client as never),
    ).resolves.toBe(true)
    await expect(
      evaluationRuntimeAuthorizationAllowsRun(snapshot, 'tenant-1', 'anthropic', client as never),
    ).resolves.toBe(false)
    await expect(
      evaluationRuntimeAuthorizationAllowsRun(snapshot, 'tenant-2', 'openai', client as never),
    ).resolves.toBe(false)
    await expect(
      evaluationRuntimeAuthorizationAllowsRun(
        {
          authorization: {
            ...snapshot.authorization,
            authorizationId: '11111111-1111-4111-8111-111111111111',
          },
        },
        'tenant-1',
        'openai',
        client as never,
      ),
    ).resolves.toBe(false)
  })
})
