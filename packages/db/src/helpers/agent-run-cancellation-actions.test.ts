import { describe, expect, it, vi } from 'vitest'

import {
  AgentRunCancellationError,
  requestAgentRunCancellationAction,
} from './agent-run-cancellation-actions'

const actor = { type: 'HUMAN' as const, id: 'admin-1', role: 'PLATFORM_ADMIN' as const }
const input = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  agentRunId: 'run-1',
  reason: 'Operator requested stop',
  actor,
}

function harness(run: unknown = { id: 'run-1', status: 'RUNNING', cancelRequestedAt: null }) {
  const findFirst = vi.fn().mockResolvedValue(run)
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  const timelineCreate = vi.fn().mockResolvedValue({ id: 'timeline-1' })
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' })
  const tx = {
    agentRun: { findFirst, updateMany },
    agentTimelineEvent: { create: timelineCreate },
    auditLog: { create: auditCreate },
  }
  const transaction = vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx))
  return {
    client: { $transaction: transaction },
    transaction,
    findFirst,
    updateMany,
    timelineCreate,
    auditCreate,
  }
}

describe('requestAgentRunCancellationAction', () => {
  it('rejects invalid authority, scope and reason before opening a transaction', async () => {
    const h = harness()
    for (const overrides of [
      { tenantId: '' },
      { venueId: '' },
      { agentRunId: '' },
      { reason: ' ' },
      { reason: 'x'.repeat(501) },
      { actor: { ...actor, type: 'SYSTEM' } },
      { actor: { ...actor, role: 'OWNER' } },
      { tenantId: null },
      { actor: null },
      { actor: { ...actor, id: null } },
      { reason: null },
    ]) {
      await expect(
        requestAgentRunCancellationAction({ ...input, ...overrides } as never, h.client as never),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      } satisfies Partial<AgentRunCancellationError>)
    }
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it.each(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL'])(
    'requests cancellation atomically from %s',
    async (status) => {
      const h = harness({ id: 'run-1', status, cancelRequestedAt: null })
      const result = await requestAgentRunCancellationAction(input, h.client as never)

      expect(h.findFirst).toHaveBeenCalledWith({
        where: { id: 'run-1', tenantId: 'tenant-1', venueId: 'venue-1' },
        select: { id: true, status: true, cancelRequestedAt: true },
      })
      expect(h.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'run-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          status,
          cancelRequestedAt: null,
        },
        data: { cancelRequestedAt: expect.any(Date) },
      })
      expect(h.timelineCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentRunId: 'run-1',
          actorType: 'HUMAN',
          actorId: 'admin-1',
          eventType: 'CANCELLATION_REQUESTED',
          message: 'A platform administrator requested cancellation.',
          data: { reasonLength: 23 },
        },
      })
      expect(h.auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          actorRole: 'PLATFORM_ADMIN',
          action: 'admin.agent-run.cancellation-requested',
          targetType: 'AgentRun',
          targetId: 'run-1',
          beforeState: { status, cancelRequested: false },
          afterState: expect.objectContaining({ status, cancelRequested: true, reasonLength: 23 }),
        }),
      })
      expect(JSON.stringify(h.timelineCreate.mock.calls)).not.toContain(input.reason)
      expect(JSON.stringify(h.auditCreate.mock.calls)).not.toContain(input.reason)
      expect(result).toMatchObject({ outcome: 'REQUESTED', status })
    },
  )

  it('replays existing cancellation intent without duplicate evidence', async () => {
    const requestedAt = new Date('2026-08-11T20:00:00.000Z')
    const h = harness({ id: 'run-1', status: 'RUNNING', cancelRequestedAt: requestedAt })
    await expect(
      requestAgentRunCancellationAction(
        {
          ...input,
          reason: 'A later authorized reason',
          actor: { ...actor, id: 'admin-2' },
        },
        h.client as never,
      ),
    ).resolves.toEqual({
      id: 'run-1',
      status: 'RUNNING',
      cancelRequestedAt: requestedAt,
      outcome: 'REPLAYED',
    })
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(h.timelineCreate).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

  it.each(['COMPLETED', 'FAILED', 'CANCELLED'])(
    'reports terminal %s truthfully without mutation',
    async (status) => {
      const h = harness({ id: 'run-1', status, cancelRequestedAt: null })
      await expect(requestAgentRunCancellationAction(input, h.client as never)).resolves.toEqual({
        id: 'run-1',
        status,
        cancelRequestedAt: null,
        outcome: 'TERMINAL',
      })
      expect(h.updateMany).not.toHaveBeenCalled()
      expect(h.timelineCreate).not.toHaveBeenCalled()
    },
  )

  it('fails exact cross-scope lookup closed', async () => {
    const h = harness(null)
    await expect(requestAgentRunCancellationAction(input, h.client as never)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
    expect(h.updateMany).not.toHaveBeenCalled()
  })

  it('normalizes a lost CAS only after an authoritative replay or terminal read', async () => {
    const requestedAt = new Date('2026-08-11T20:00:00.000Z')
    const replay = harness()
    replay.updateMany.mockResolvedValue({ count: 0 })
    replay.findFirst
      .mockResolvedValueOnce({ id: 'run-1', status: 'RUNNING', cancelRequestedAt: null })
      .mockResolvedValueOnce({ id: 'run-1', status: 'RUNNING', cancelRequestedAt: requestedAt })
    await expect(
      requestAgentRunCancellationAction(input, replay.client as never),
    ).resolves.toMatchObject({ outcome: 'REPLAYED' })

    const terminal = harness()
    terminal.updateMany.mockResolvedValue({ count: 0 })
    terminal.findFirst
      .mockResolvedValueOnce({ id: 'run-1', status: 'RUNNING', cancelRequestedAt: null })
      .mockResolvedValueOnce({ id: 'run-1', status: 'COMPLETED', cancelRequestedAt: null })
    await expect(
      requestAgentRunCancellationAction(input, terminal.client as never),
    ).resolves.toMatchObject({ outcome: 'TERMINAL', status: 'COMPLETED' })
    expect(replay.timelineCreate).not.toHaveBeenCalled()
    expect(terminal.timelineCreate).not.toHaveBeenCalled()
  })

  it('maps unresolved CAS loss to conflict and makes strict audit failure fatal', async () => {
    const conflict = harness()
    conflict.updateMany.mockResolvedValue({ count: 0 })
    await expect(
      requestAgentRunCancellationAction(input, conflict.client as never),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const auditFailure = harness()
    auditFailure.auditCreate.mockRejectedValue(new Error('audit unavailable'))
    await expect(
      requestAgentRunCancellationAction(input, auditFailure.client as never),
    ).rejects.toThrow('audit unavailable')
    expect(auditFailure.timelineCreate).toHaveBeenCalledOnce()
  })
})
