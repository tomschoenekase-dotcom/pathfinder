import { describe, expect, it, vi } from 'vitest'

import { resolveRuntimeAiWorkloadConfiguration } from './ai-workload-configuration-actions'

function row(overrides: Record<string, unknown>) {
  return {
    id: 'override',
    workloadId: 'guest-chat',
    enabled: true,
    primaryModelKey: null,
    primaryModelKeySet: false,
    fallbackEnabled: null,
    fallbackEnabledSet: false,
    fallbackModelKeys: [],
    fallbackModelKeysSet: false,
    timeoutMs: null,
    timeoutMsSet: false,
    maxAttempts: null,
    maxAttemptsSet: false,
    maxOutputTokens: null,
    maxOutputTokensSet: false,
    requestBudgetCeilingE8Usd: null,
    requestBudgetCeilingE8UsdSet: false,
    unsafeChangesEnabled: false,
    isTombstone: false,
    reason: 'runtime test',
    revision: 1,
    createdBy: 'admin',
    updatedBy: 'admin',
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
    ...overrides,
  }
}

describe('runtime AI configuration resolution', () => {
  it('selects the production Luna default without changing the workload identity', async () => {
    const previous = process.env.GUEST_CHAT_DEFAULT_MODEL_KEY
    process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = 'guest-chat-luna'
    try {
      const result = await resolveRuntimeAiWorkloadConfiguration(
        { workloadId: 'guest-chat' },
        {} as never,
      )
      expect(result).toMatchObject({
        workloadId: 'guest-chat',
        primaryModelKey: 'guest-chat-luna',
        model: { provider: 'openai', model: 'gpt-6-luna' },
      })
    } finally {
      if (previous === undefined) delete process.env.GUEST_CHAT_DEFAULT_MODEL_KEY
      else process.env.GUEST_CHAT_DEFAULT_MODEL_KEY = previous
    }
  })

  it('loads scoped rows with tenant predicates and applies venue precedence', async () => {
    const platform = vi.fn().mockResolvedValue(row({ timeoutMs: 9_000, timeoutMsSet: true }))
    const scoped = vi
      .fn()
      .mockResolvedValueOnce(
        row({ maxAttempts: 3, maxAttemptsSet: true, unsafeChangesEnabled: true }),
      )
      .mockResolvedValueOnce(row({ timeoutMs: 2_000, timeoutMsSet: true }))
    const result = await resolveRuntimeAiWorkloadConfiguration(
      { workloadId: 'guest-chat', tenantId: 'tenant-a', venueId: 'venue-a' },
      {
        aiWorkloadConfigurationOverride: { findFirst: platform },
        aiScopedWorkloadConfigurationOverride: { findFirst: scoped },
      } as never,
    )

    expect(result).toMatchObject({ timeoutMs: 2_000, maxAttempts: 3 })
    expect(scoped).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { tenantId: 'tenant-a', venueScopeKey: '__client__', workloadId: 'guest-chat' },
      }),
    )
    expect(scoped).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { tenantId: 'tenant-a', venueScopeKey: 'venue-a', workloadId: 'guest-chat' },
      }),
    )
  })
})
