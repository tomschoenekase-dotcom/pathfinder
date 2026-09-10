import { describe, expect, it, vi } from 'vitest'
vi.mock('./agent-workflow-run-binding', () => ({
  bindEligibleAgentWorkflows: vi.fn(async () => ({ bindings: [], replayed: false })),
}))

import { createAgentTaskAction } from './agent-task-actions'

describe('agent task action', () => {
  it('freezes enabled specialist scope into a queued run without execution', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'run-1',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          requestPrompt: 'Research this issue.',
          status: 'QUEUED',
          createdAt: new Date('2026-08-18T17:30:00Z'),
        }),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'agent-1',
          agentType: 'OPERATIONS',
          accessScope: 'VENUE',
          accessCapabilities: ['operations.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'provider',
          defaultModel: 'model',
        }),
      },
      prospectTerritory: { count: vi.fn().mockResolvedValue(1) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
    }
    const result = await createAgentTaskAction(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff002',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        prompt: 'Research this issue.',
        actor: { actorType: 'HUMAN', actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' },
      },
      client as never,
    )
    expect(result.executionTriggered).toBe(false)
    expect(transaction.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'QUEUED', requestPrompt: 'Research this issue.' }),
      }),
    )
  })

  it('freezes an explicit reviewed territory scope for a prospect-capable AgentRun', async () => {
    const transaction = {
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'run-prospect',
          venueId: 'venue-1',
          agentIdentityId: 'agent-1',
          requestPrompt: 'Research this cohort.',
          status: 'QUEUED',
          createdAt: new Date('2026-08-20T12:00:00Z'),
        }),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'agent-1',
          agentType: 'OPERATIONS',
          accessScope: 'CLIENT',
          accessCapabilities: ['prospects.read', 'prospects.draft'],
          autonomyLevel: 'DRAFT',
          autonomousActions: [],
          defaultProvider: 'codex-bridge',
          defaultModel: 'subscription-default',
        }),
      },
      prospectTerritory: { count: vi.fn().mockResolvedValue(1) },
      agentTimelineEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'message-1' }) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    const client = {
      $transaction: vi.fn(async (operation: (value: unknown) => unknown) => operation(transaction)),
    }
    await createAgentTaskAction(
      {
        operationId: '86d4ee39-a7c7-44ab-bf24-75c187cff003',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: 'agent-1',
        prompt: 'Research this cohort.',
        promptIdentity: 'crm-research@1',
        prospectScope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
        actor: { actorType: 'HUMAN', actorId: 'admin-1', auditRole: 'PLATFORM_ADMIN' },
      },
      client as never,
    )
    expect(transaction.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopeSnapshot: expect.objectContaining({
            prospectScope: { mode: 'TERRITORIES', territoryIds: ['territory-1'] },
            promptIdentity: 'crm-research@1',
          }),
        }),
      }),
    )
  })
})

describe('immutable Content source assignment', () => {
  const assignment = {
    version: 1 as const,
    kind: 'FILE_EXTRACTION' as const,
    intakeRunId: 'intake-1',
    receiptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    extractedTextHash: 'a'.repeat(64),
  }
  const input = {
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenantId: 'tenant-1',
    venueId: 'venue-1',
    agentIdentityId: 'content-1',
    prompt: 'Review this source.',
    sourceAssignment: assignment,
    actor: {
      actorType: 'HUMAN' as const,
      actorId: 'admin-1',
      auditRole: 'PLATFORM_ADMIN' as const,
    },
  }
  function setup() {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      agentRun: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'run-1', status: 'QUEUED' }),
      },
      agentIdentity: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'content-1',
          agentType: 'CONTENT',
          accessScope: 'VENUE',
          accessCapabilities: ['intake.read'],
          autonomyLevel: 'READ_ONLY',
          autonomousActions: [],
          defaultProvider: 'fixture',
          defaultModel: 'fixture',
        }),
      },
      intakeFileExtractionReceipt: {
        findFirst: vi.fn().mockResolvedValue({ id: assignment.receiptId }),
      },
      agentTimelineEvent: { create: vi.fn() },
      agentMessage: { create: vi.fn() },
      auditLog: { create: vi.fn() },
    }
    const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) }
    return { tx, client }
  }
  it('freezes one exact receipt without original bytes or text', async () => {
    const { tx, client } = setup()
    await createAgentTaskAction(input, client as never)
    expect(tx.agentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopeSnapshot: expect.objectContaining({ sourceAssignment: assignment }),
        }),
      }),
    )
    expect(tx.intakeFileExtractionReceipt.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        runId: 'intake-1',
        outcome: 'SUCCEEDED',
        review: { is: null },
        extractedTextHash: assignment.extractedTextHash,
      }),
      select: { id: true },
    })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
  })
  it('rejects a missing, wrong-scope, stale or reviewed receipt before creating work', async () => {
    const { tx, client } = setup()
    tx.intakeFileExtractionReceipt.findFirst.mockResolvedValue(null)
    await expect(createAgentTaskAction(input, client as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(tx.agentRun.create).not.toHaveBeenCalled()
  })
  it('rejects an identity without intake.read', async () => {
    const { tx, client } = setup()
    tx.agentIdentity.findFirst.mockResolvedValue({
      id: 'content-1',
      agentType: 'CONTENT',
      accessScope: 'VENUE',
      accessCapabilities: [],
      autonomyLevel: 'READ_ONLY',
      autonomousActions: [],
      defaultProvider: 'fixture',
      defaultModel: 'fixture',
    })
    await expect(createAgentTaskAction(input, client as never)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(tx.agentRun.create).not.toHaveBeenCalled()
  })
  it('replays exact assignment but rejects changing or dropping it', async () => {
    const { tx, client } = setup()
    tx.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      venueId: input.venueId,
      agentIdentityId: input.agentIdentityId,
      requestPrompt: input.prompt,
      scopeSnapshot: { sourceAssignment: assignment },
    })
    await expect(createAgentTaskAction(input, client as never)).resolves.toMatchObject({
      replayed: true,
    })
    for (const sourceAssignment of [
      undefined,
      { ...assignment, extractedTextHash: 'b'.repeat(64) },
    ]) {
      await expect(
        createAgentTaskAction({ ...input, sourceAssignment }, client as never),
      ).rejects.toMatchObject({ code: 'CONFLICT' })
    }
    expect(tx.agentRun.create).not.toHaveBeenCalled()
  })
})
