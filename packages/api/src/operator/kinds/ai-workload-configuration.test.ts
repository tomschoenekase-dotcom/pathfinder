/* eslint-disable @typescript-eslint/no-explicit-any -- scoped action fakes */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  reset: vi.fn(),
  resolve: vi.fn(),
  provider: vi.fn(),
}))
vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  saveAiWorkloadConfigurationOverrideAction: mocks.save,
  resetAiWorkloadConfigurationOverrideAction: mocks.reset,
  resolveRuntimeAiWorkloadConfiguration: mocks.resolve,
}))
vi.mock('../../routers/admin/ai-provider-connections', () => ({
  providerHasExecutionKey: mocks.provider,
}))
import { AiConfigurationActionError } from '@pathfinder/db'
import { OPERATOR_MCP_INPUTS, OPERATOR_MCP_OUTPUTS } from '@pathfinder/contracts/operator-mcp'
import { venueAiConfigurationReadTool as read } from '../tools/ai-workload-configuration'
import {
  venueAiConfigurationKind as save,
  venueAiResetKind as reset,
} from './ai-workload-configuration'

const scope = { tenantId: 'tenant-a', venueId: 'venue-a', workloadId: 'guest-chat' }
const operationId = '8a1f1c0e-2f87-4b5e-9d57-6a2b6d7a9d10'
const raw = {
  ...scope,
  operationId,
  expectedRevision: null,
  enabled: true,
  values: { primaryModelKey: 'guest-chat-sol', maxOutputTokens: 100 },
  reason: 'Owner selection',
}
const context = () =>
  ({
    database: {
      tenant: { findUnique: vi.fn().mockResolvedValue({ id: scope.tenantId }) },
      venue: { findFirst: vi.fn().mockResolvedValue({ id: scope.venueId }) },
      aiScopedWorkloadConfigurationOverride: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    grant: { userId: 'human', allTenants: false, tenantIds: [scope.tenantId] },
    allowedUserIds: new Set(['human']),
    actor: { type: 'HUMAN', id: 'human', role: 'PLATFORM_ADMIN' },
  }) as any
beforeEach(() => {
  vi.clearAllMocks()
  mocks.provider.mockReturnValue(true)
  mocks.save.mockResolvedValue({ revision: 1, enabled: true })
  mocks.reset.mockResolvedValue({ revision: 2, isTombstone: true })
  mocks.resolve.mockResolvedValue({
    primaryModelKey: 'guest-chat-sol',
    model: { provider: 'openai', model: 'gpt-test' },
    fallback: { enabled: false, modelKeys: [] },
    timeoutMs: 1000,
    maxAttempts: 1,
    maxOutputTokens: 100,
    requestBudgetCeilingE8Usd: null,
    sources: { primaryModelKey: 'VENUE' },
  })
})
describe('venue AI workload operator parity', () => {
  it('rejects arbitrary keys, actor authority, global scope and workload-incompatible models', () => {
    expect(() => save.parse({ ...raw, scope: { level: 'WORKLOAD' } })).toThrow()
    expect(() => save.parse({ ...raw, actor: { role: 'PLATFORM_ADMIN' } })).toThrow()
    expect(() => save.parse({ ...raw, values: { arbitrary: true } })).toThrow()
    expect(() => save.parse({ ...raw, workloadId: 'not-a-workload' })).toThrow()
    expect(() => save.parse({ ...raw, values: { primaryModelKey: 'not-a-model' } })).toThrow()
  })
  it('requires a revision for save and a positive revision for reset', () => {
    const missing: Partial<typeof raw> = { ...raw }
    delete missing.expectedRevision
    expect(() => save.parse(missing)).toThrow()
    expect(() =>
      reset.parse({ ...scope, operationId, expectedRevision: null, reason: 'Reset' }),
    ).toThrow()
  })
  it('refuses sibling tenant reads and both proposal kinds before domain access', async () => {
    await expect(read.handler({ ...scope, tenantId: 'tenant-b' }, context())).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
    for (const kind of [save, reset]) {
      await expect(
        kind.authorize!({ ...raw, tenantId: 'tenant-b' } as any, context()),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('refuses an unallowlisted owner and a venue not belonging to the target tenant', async () => {
    const ctx = context()
    ctx.allowedUserIds.clear()
    await expect(save.authorize!(save.parse(raw), ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const missing = context()
    missing.database.venue.findFirst.mockResolvedValue(null)
    await expect(read.handler(scope, missing)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.resolve).not.toHaveBeenCalled()
  })
  it('returns effective values, registered options and exact venue-only revision without provider execution', async () => {
    const ctx = context()
    const result = await read.handler(scope, ctx)
    expect(
      OPERATOR_MCP_OUTPUTS['venues.get_ai_workload_configuration'].safeParse(result).success,
    ).toBe(true)
    expect(mocks.resolve).toHaveBeenCalledWith({ level: 'VENUE', ...scope }, ctx.database)
    expect(ctx.database.aiScopedWorkloadConfigurationOverride.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: scope.tenantId,
        venueScopeKey: scope.venueId,
        workloadId: scope.workloadId,
      },
    })
  })
  it('forwards canonical typed replacement, explicit revision and the existing human actor', async () => {
    const ctx = context()
    const args = save.parse(raw)
    await save.apply(args, ctx)
    expect(mocks.save).toHaveBeenCalledWith(
      {
        scope: { level: 'VENUE', ...scope },
        expectedRevision: null,
        enabled: true,
        values: raw.values,
        unsafeChangesEnabled: false,
        reason: raw.reason,
        actor: ctx.actor,
      },
      ctx.database,
    )
    expect(await save.targetVersion(args, ctx)).toBe(null)
    expect(await save.currentVersion(args, ctx)).toBe(null)
  })
  it('retains canonical stale and unsafe-cost refusals', async () => {
    mocks.save.mockRejectedValueOnce(new AiConfigurationActionError('CONFLICT', 'Changed'))
    await expect(save.apply(save.parse(raw), context())).rejects.toMatchObject({ code: 'STALE' })
    mocks.save.mockRejectedValueOnce(
      new AiConfigurationActionError('UNSAFE_CHANGE_REQUIRES_APPROVAL', 'Cost increase'),
    )
    await expect(save.apply(save.parse(raw), context())).rejects.toMatchObject({
      code: 'UNSAFE_CHANGE_REQUIRES_APPROVAL',
    })
  })
  it('refuses enabled unconfigured provider routes and permits disabling them', async () => {
    mocks.provider.mockReturnValue(false)
    await expect(save.apply(save.parse(raw), context())).rejects.toThrow(
      'provider configuration is missing',
    )
    expect(mocks.save).not.toHaveBeenCalled()
    await save.apply(save.parse({ ...raw, enabled: false }), context())
    expect(mocks.save).toHaveBeenCalledTimes(1)
  })
  it('resets only the exact venue override and revision', async () => {
    const ctx = context()
    const args = reset.parse({
      ...scope,
      operationId,
      expectedRevision: 7,
      reason: 'Inherit defaults',
    })
    await reset.apply(args, ctx)
    expect(mocks.reset).toHaveBeenCalledWith(
      {
        scope: { level: 'VENUE', ...scope },
        expectedRevision: 7,
        reason: 'Inherit defaults',
        actor: ctx.actor,
      },
      ctx.database,
    )
  })
  it('advertises typed inputs without allowing a global/client scope', () => {
    expect(
      OPERATOR_MCP_INPUTS['venues.propose_ai_workload_configuration'].safeParse(raw).success,
    ).toBe(true)
  })
})
