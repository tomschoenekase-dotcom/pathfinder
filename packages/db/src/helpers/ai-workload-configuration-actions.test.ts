import { beforeEach, describe, expect, it, vi } from 'vitest'

const writeAudit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ writeAuditLogStrict: writeAudit }))

import {
  resetAiWorkloadConfigurationOverrideAction,
  saveAiWorkloadConfigurationOverrideAction,
  type AiConfigurationActionClient,
} from './ai-workload-configuration-actions'

const now = new Date('2030-01-01T00:00:00.000Z')
const actor = { type: 'HUMAN' as const, id: 'admin_1', role: 'PLATFORM_ADMIN' as const }
const scope = {
  level: 'VENUE' as const,
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  workloadId: 'guest-chat' as const,
}

const baseRow = {
  id: 'override_1',
  workloadId: 'guest-chat',
  enabled: false,
  primaryModelKey: null,
  primaryModelKeySet: false,
  fallbackEnabled: null,
  fallbackEnabledSet: false,
  fallbackModelKeys: [],
  fallbackModelKeysSet: false,
  timeoutMs: 8_000,
  timeoutMsSet: true,
  maxAttempts: 1,
  maxAttemptsSet: true,
  maxOutputTokens: null,
  maxOutputTokensSet: false,
  requestBudgetCeilingE8Usd: '100',
  requestBudgetCeilingE8UsdSet: true,
  unsafeChangesEnabled: false,
  isTombstone: false,
  reason: 'stage safely',
  revision: 1,
  createdBy: 'admin_1',
  updatedBy: 'admin_1',
  createdAt: now,
  updatedAt: now,
}

const tenantFindFirst = vi.fn()
const venueFindFirst = vi.fn()
const scopedFindFirst = vi.fn()
const scopedCreate = vi.fn()
const scopedUpdateMany = vi.fn()
const scopedHistoryCreate = vi.fn()
const globalFindFirst = vi.fn()
const globalCreate = vi.fn()
const globalUpdateMany = vi.fn()
const globalHistoryCreate = vi.fn()
const tx = {
  tenant: { findFirst: tenantFindFirst },
  venue: { findFirst: venueFindFirst },
  aiScopedWorkloadConfigurationOverride: {
    findFirst: scopedFindFirst,
    create: scopedCreate,
    updateMany: scopedUpdateMany,
  },
  aiScopedWorkloadConfigurationHistory: { create: scopedHistoryCreate },
  aiWorkloadConfigurationOverride: {
    findFirst: globalFindFirst,
    create: globalCreate,
    updateMany: globalUpdateMany,
  },
  aiWorkloadConfigurationHistory: { create: globalHistoryCreate },
  auditLog: { create: vi.fn() },
}
const client = {
  $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
} as unknown as AiConfigurationActionClient

describe('AI workload configuration domain actions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    tenantFindFirst.mockResolvedValue({ id: 'tenant_1' })
    venueFindFirst.mockResolvedValue({ id: 'venue_1' })
    writeAudit.mockResolvedValue(undefined)
    scopedHistoryCreate.mockResolvedValue({ id: 'history_1' })
    globalHistoryCreate.mockResolvedValue({ id: 'history_1' })
  })

  it('creates a disabled staged venue override with exact scope and immutable evidence', async () => {
    scopedFindFirst.mockResolvedValueOnce(null)
    scopedCreate.mockResolvedValue(baseRow)
    const result = await saveAiWorkloadConfigurationOverrideAction(
      {
        scope,
        actor,
        expectedRevision: null,
        enabled: false,
        values: { timeoutMs: 8_000, maxAttempts: 1, requestBudgetCeilingE8Usd: '100' },
        unsafeChangesEnabled: false,
        reason: 'stage safely',
      },
      client,
    )

    expect(venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { id: true },
    })
    expect(scopedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          venueScopeKey: 'venue_1',
          enabled: false,
        }),
      }),
    )
    expect(scopedHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'CREATED', revision: 1 }),
      }),
    )
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', actorRole: 'PLATFORM_ADMIN' }),
      tx,
    )
    expect(result.enabled).toBe(false)
  })

  it('rejects cross-tenant venue scope without mutation or audit', async () => {
    venueFindFirst.mockResolvedValue(null)
    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor,
          expectedRevision: null,
          enabled: false,
          values: {},
          unsafeChangesEnabled: false,
          reason: 'should not write',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(scopedCreate).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('requires explicit approval for spend-expanding or retry-expanding activation', async () => {
    scopedFindFirst.mockResolvedValue(baseRow)
    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor,
          expectedRevision: 1,
          enabled: true,
          values: { maxAttempts: 5, requestBudgetCeilingE8Usd: '200' },
          unsafeChangesEnabled: false,
          reason: 'expands spend',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_CHANGE_REQUIRES_APPROVAL' })
    expect(scopedUpdateMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('treats omitted replacement budget as cap removal and requires explicit approval', async () => {
    const active = { ...baseRow, enabled: true }
    scopedFindFirst.mockResolvedValueOnce(active).mockResolvedValueOnce(null)
    globalFindFirst.mockResolvedValue(null)

    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor,
          expectedRevision: 1,
          enabled: true,
          values: { timeoutMs: 8_000, maxAttempts: 1 },
          unsafeChangesEnabled: false,
          reason: 'replacement accidentally omits cap',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_CHANGE_REQUIRES_APPROVAL' })
    expect(scopedUpdateMany).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('allows deliberate cap removal only with unsafe approval, CAS, history, and audit', async () => {
    const active = { ...baseRow, enabled: true }
    const saved = {
      ...active,
      requestBudgetCeilingE8Usd: null,
      requestBudgetCeilingE8UsdSet: false,
      unsafeChangesEnabled: true,
      reason: 'approved cap removal',
      revision: 2,
    }
    scopedFindFirst
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(saved)
    globalFindFirst.mockResolvedValue(null)
    scopedUpdateMany.mockResolvedValue({ count: 1 })

    const result = await saveAiWorkloadConfigurationOverrideAction(
      {
        scope,
        actor,
        expectedRevision: 1,
        enabled: true,
        values: { timeoutMs: 8_000, maxAttempts: 1 },
        unsafeChangesEnabled: true,
        reason: 'approved cap removal',
      },
      client,
    )

    expect(scopedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'override_1', tenantId: 'tenant_1', revision: 1 },
        data: expect.objectContaining({ requestBudgetCeilingE8UsdSet: false }),
      }),
    )
    expect(scopedHistoryCreate).toHaveBeenCalled()
    expect(writeAudit).toHaveBeenCalled()
    expect(result.revision).toBe(2)
  })

  it('uses revision CAS and emits no false evidence for a stale editor', async () => {
    scopedFindFirst.mockResolvedValue(baseRow)
    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor,
          expectedRevision: 2,
          enabled: false,
          values: {},
          unsafeChangesEnabled: false,
          reason: 'stale edit',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(scopedUpdateMany).not.toHaveBeenCalled()
    expect(scopedHistoryCreate).not.toHaveBeenCalled()
  })

  it('normalizes a concurrent null-revision create unique race to conflict', async () => {
    const racingClient = {
      $transaction: vi.fn().mockRejectedValue({ code: 'P2002', meta: { target: ['tenant_id'] } }),
    } as unknown as AiConfigurationActionClient

    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor,
          expectedRevision: null,
          enabled: false,
          values: {},
          unsafeChangesEnabled: false,
          reason: 'concurrent create',
        },
        racingClient,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('resets without deletion, preserving a tombstone, revision, history, and audit', async () => {
    const resetRow = {
      ...baseRow,
      enabled: false,
      timeoutMs: null,
      timeoutMsSet: false,
      requestBudgetCeilingE8Usd: null,
      requestBudgetCeilingE8UsdSet: false,
      isTombstone: true,
      reason: 'return to inheritance',
      revision: 2,
    }
    scopedFindFirst.mockResolvedValueOnce(baseRow).mockResolvedValueOnce(resetRow)
    scopedUpdateMany.mockResolvedValue({ count: 1 })

    const result = await resetAiWorkloadConfigurationOverrideAction(
      { scope, actor, expectedRevision: 1, reason: 'return to inheritance' },
      client,
    )

    expect(scopedUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'override_1', tenantId: 'tenant_1', revision: 1 },
        data: expect.objectContaining({ enabled: false, isTombstone: true }),
      }),
    )
    expect(scopedHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'RESET', revision: 2 }) }),
    )
    expect(result.isTombstone).toBe(true)
  })

  it('rejects non-platform or non-human actors before opening a transaction', async () => {
    await expect(
      saveAiWorkloadConfigurationOverrideAction(
        {
          scope,
          actor: { type: 'HUMAN', id: 'owner_1', role: 'OWNER' } as never,
          expectedRevision: null,
          enabled: false,
          values: {},
          unsafeChangesEnabled: false,
          reason: 'not authorized',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })
})
