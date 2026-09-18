import { describe, expect, it, vi } from 'vitest'

const configEnv = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  OPENAI_API_KEY: undefined as string | undefined,
  DEEPSEEK_API_KEY: undefined as string | undefined,
}))

vi.mock('@pathfinder/config', () => ({ env: configEnv }))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminAiWorkloadConfigurationRouter } from './ai-workload-configuration'

const app = router({ admin: adminAiWorkloadConfigurationRouter })

function context(isPlatformAdmin: boolean, options?: { missingVenue?: boolean }): TRPCContext {
  return {
    db: {
      venue: {
        findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
          options?.missingVenue ? null : { id: where.id },
        ),
      },
      aiWorkloadConfigurationOverride: { findMany: vi.fn(async () => []) },
      aiScopedWorkloadConfigurationOverride: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      },
    } as unknown as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'admin_1',
      activeTenantId: null,
      role: null,
      isPlatformAdmin,
    },
  }
}

describe('admin AI workload configuration', () => {
  it('projects only approved global guest-chat choices and secret-safe provider setup state', async () => {
    const ctx = context(true)
    const result = await app.createCaller(ctx).admin.getAdminAiSystems()

    expect(result.customerChat.workloadId).toBe('guest-chat')
    expect(result.customerChat.modelOptions.map((option) => option.key)).toEqual([
      'guest-chat',
      'guest-chat-openai',
      'guest-chat-deepseek-flash',
      'guest-chat-deepseek-pro',
    ])
    expect(
      result.customerChat.modelOptions.every((option) => typeof option.available === 'boolean'),
    ).toBe(true)
    expect(result.customerChat.effective.primaryModelKey).toBe('guest-chat')
    expect(result.customerChat.scopedExceptionCount).toBe(0)
    expect(result.customerChat.providerConnections).toEqual([
      {
        id: 'anthropic',
        name: 'Anthropic',
        configured: true,
        environmentVariable: 'ANTHROPIC_API_KEY',
      },
      {
        id: 'openai',
        name: 'OpenAI',
        configured: false,
        environmentVariable: 'OPENAI_API_KEY',
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        configured: false,
        environmentVariable: 'DEEPSEEK_API_KEY',
      },
    ])
    expect(ctx.db.aiScopedWorkloadConfigurationOverride.count).toHaveBeenCalledWith({
      where: { workloadId: 'guest-chat', enabled: true, isTombstone: false },
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('test-anthropic-key')
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{8,}/u)
    expect(result.limitations).toMatchObject({
      providerExecution: false,
      deepSeek: true,
      openRouter: false,
      priceTierRouting: false,
    })
  })

  it('requires platform-admin authorization before global configuration reads', async () => {
    const ctx = context(false)
    await expect(
      app.createCaller(ctx).admin.getVenueAiWorkloadConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(ctx.db.aiWorkloadConfigurationOverride.findMany).not.toHaveBeenCalled()
  })

  it('uses exact tenant and venue predicates and resolves registry defaults', async () => {
    const ctx = context(true)
    const result = await app
      .createCaller(ctx)
      .admin.getVenueAiWorkloadConfiguration({ tenantId: 'tenant_1', venueId: 'venue_7' })

    expect(ctx.db.venue.findFirst).toHaveBeenCalledWith({
      where: { id: 'venue_7', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(ctx.db.aiScopedWorkloadConfigurationOverride.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { tenantId: 'tenant_1', venueScopeKey: '__client__' } }),
    )
    expect(ctx.db.aiScopedWorkloadConfigurationOverride.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { tenantId: 'tenant_1', venueScopeKey: 'venue_7' } }),
    )
    expect(result.scope).toEqual({ tenantId: 'tenant_1', venueId: 'venue_7' })
    expect(result.workloads).toHaveLength(17)
    expect(result.workloads.map((workload) => workload.workloadId)).toContain('guest-chat-openai')
    expect(result.workloads.map((workload) => workload.workloadId)).toContain('client-tochi')
    expect(result.workloads.map((workload) => workload.workloadId)).toContain(
      'company-brain-retrieval-evaluation',
    )
    expect(result.workloads.map((workload) => workload.workloadId)).toContain(
      'guest-answer-attribution-evaluation',
    )
    expect(result.workloads.every((workload) => workload.effectiveSource === 'PLATFORM')).toBe(true)
    expect(result.providerExecution).toBe(false)
    expect(result.operationalInventory.entries).toHaveLength(result.workloads.length)
    expect(result.operationalInventory.entries.every((entry) => entry.adapterCallable)).toBe(true)
    expect(
      result.operationalInventory.entries.every(
        (entry) =>
          entry.providerConfiguration === 'UNKNOWN' &&
          entry.measured.latencyMs === null &&
          entry.measured.estimatedCostUsd === null &&
          entry.measured.invoiceCostUsd === null,
      ),
    ).toBe(true)
    expect(result.operationalInventory.omissions).toContain(
      'realtime voice uses its dedicated route registry',
    )
  })

  it('does not query configuration rows when venue ownership is absent', async () => {
    const ctx = context(true, { missingVenue: true })
    await expect(
      app.createCaller(ctx).admin.getVenueAiWorkloadConfiguration({
        tenantId: 'tenant_1',
        venueId: 'venue_other',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ctx.db.aiWorkloadConfigurationOverride.findMany).not.toHaveBeenCalled()
    expect(ctx.db.aiScopedWorkloadConfigurationOverride.findMany).not.toHaveBeenCalled()
  })

  it('returns no secret-shaped configuration or invented invoice data', async () => {
    const result = await app
      .createCaller(context(true))
      .admin.getVenueAiWorkloadConfiguration({ tenantId: 'tenant_1', venueId: 'venue_1' })
    const serialized = JSON.stringify(result)

    expect(result.workloads.every((workload) => workload.fallback.enabled === false)).toBe(true)
    expect(serialized).not.toMatch(/apiKey|credential|secret|endpoint|baseUrl/iu)
    expect(result.workloads.every((item) => item.pricingEstimate.invoiceAmount === false)).toBe(
      true,
    )
    expect(serialized).toContain('configuredPricingEstimate')
    expect(serialized).toContain('invoice cost are unknown')
  })

  it('rejects unknown registry keys and cross-kind fallback before any action', async () => {
    const caller = app.createCaller(context(true))
    await expect(
      caller.admin.saveAiWorkloadConfigurationOverride({
        scope: {
          level: 'VENUE',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          workloadId: 'guest-chat',
        },
        expectedRevision: null,
        enabled: false,
        values: { primaryModelKey: 'provider-model-name' },
        unsafeChangesEnabled: false,
        reason: 'adversarial unknown key',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    await expect(
      caller.admin.saveAiWorkloadConfigurationOverride({
        scope: {
          level: 'VENUE',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          workloadId: 'guest-chat',
        },
        expectedRevision: null,
        enabled: true,
        values: { fallback: { enabled: true, modelKeys: ['guest-query-embedding'] } },
        unsafeChangesEnabled: true,
        reason: 'cross-kind fallback',
      }),
    ).rejects.toThrow('AI model selections cannot cross workload model kinds')
  })

  it('rejects extra fields including secret-shaped input', async () => {
    await expect(
      app.createCaller(context(true)).admin.saveAiWorkloadConfigurationOverride({
        scope: {
          level: 'VENUE',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          workloadId: 'guest-chat',
        },
        expectedRevision: null,
        enabled: false,
        values: {},
        unsafeChangesEnabled: false,
        reason: 'invalid extra data',
        apiKey: 'must-not-be-accepted',
      } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects enabling a model whose provider execution key is missing', async () => {
    await expect(
      app.createCaller(context(true)).admin.saveAiWorkloadConfigurationOverride({
        scope: { level: 'WORKLOAD', workloadId: 'guest-chat' },
        expectedRevision: null,
        enabled: true,
        values: { primaryModelKey: 'guest-chat-openai' },
        unsafeChangesEnabled: true,
        reason: 'move visitor chat to the OpenAI route',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('provider configuration is missing: openai'),
    })
  })
})
