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

function harness(
  run: unknown = { id: 'run-1', status: 'RUNNING', cancelRequestedAt: null, startedAt: new Date() },
) {
  const findFirst = vi.fn().mockResolvedValue(run)
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  const timelineCreate = vi.fn().mockResolvedValue({ id: 'timeline-1' })
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit-1' })
  const messageCreate = vi.fn().mockResolvedValue({ id: 'message-1' })
  const tx = {
    agentRun: { findFirst, updateMany },
    agentTimelineEvent: { create: timelineCreate },
    agentMessage: { create: messageCreate },
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
    messageCreate,
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

  it.each(['QUEUED', 'AWAITING_INPUT', 'AWAITING_APPROVAL'])(
    'immediately cancels non-running %s work atomically',
    async (status) => {
      const startedAt = status === 'QUEUED' ? null : new Date('2026-08-11T19:00:00.000Z')
      const h = harness({ id: 'run-1', status, cancelRequestedAt: null, startedAt })
      const result = await requestAgentRunCancellationAction(input, h.client as never)

      expect(h.findFirst).toHaveBeenCalledWith({
        where: { id: 'run-1', tenantId: 'tenant-1', venueId: 'venue-1' },
        select: {
          id: true,
          status: true,
          cancelRequestedAt: true,
          startedAt: true,
          parentAgentRunId: true,
          agentIdentityId: true,
        },
      })
      expect(h.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'run-1',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          status,
          cancelRequestedAt: null,
        },
        data: {
          status: 'CANCELLED',
          cancelRequestedAt: expect.any(Date),
          startedAt: startedAt ?? expect.any(Date),
          completedAt: expect.any(Date),
        },
      })
      expect(h.timelineCreate).toHaveBeenCalledWith({
        data: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          agentRunId: 'run-1',
          actorType: 'HUMAN',
          actorId: 'admin-1',
          eventType: 'CANCELLED',
          message: 'A platform administrator cancelled this task that was not running.',
          data: { reasonLength: 23 },
        },
      })
      expect(h.auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          actorId: 'admin-1',
          actorRole: 'PLATFORM_ADMIN',
          action: 'admin.agent-run.cancelled',
          targetType: 'AgentRun',
          targetId: 'run-1',
          beforeState: { status, cancelRequested: false },
          afterState: expect.objectContaining({
            status: 'CANCELLED',
            cancelRequested: true,
            completedAt: expect.any(String),
            reasonLength: 23,
          }),
        }),
      })
      expect(JSON.stringify(h.timelineCreate.mock.calls)).not.toContain(input.reason)
      expect(JSON.stringify(h.auditCreate.mock.calls)).not.toContain(input.reason)
      expect(result).toMatchObject({ outcome: 'REQUESTED', status: 'CANCELLED' })
    },
  )

  it('records cancellation intent without stealing a running worker lease', async () => {
    const startedAt = new Date('2026-08-11T19:00:00.000Z')
    const h = harness({ id: 'run-1', status: 'RUNNING', cancelRequestedAt: null, startedAt })
    const result = await requestAgentRunCancellationAction(input, h.client as never)

    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        status: 'RUNNING',
        cancelRequestedAt: null,
      },
      data: { cancelRequestedAt: expect.any(Date) },
    })
    expect(h.timelineCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'CANCELLATION_REQUESTED' }),
    })
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'admin.agent-run.cancellation-requested',
        afterState: expect.objectContaining({ status: 'RUNNING', cancelRequested: true }),
      }),
    })
    expect(result).toMatchObject({ outcome: 'REQUESTED', status: 'RUNNING' })
  })

  it('finalizes one legacy pending cancellation while retaining its original request time', async () => {
    const requestedAt = new Date('2026-08-11T20:00:00.000Z')
    const h = harness({
      id: 'run-1',
      status: 'AWAITING_INPUT',
      cancelRequestedAt: requestedAt,
      startedAt: new Date('2026-08-11T19:00:00.000Z'),
    })

    const result = await requestAgentRunCancellationAction(input, h.client as never)

    expect(h.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'run-1',
        status: 'AWAITING_INPUT',
        cancelRequestedAt: requestedAt,
      }),
      data: expect.objectContaining({
        status: 'CANCELLED',
        cancelRequestedAt: requestedAt,
        completedAt: expect.any(Date),
      }),
    })
    expect(h.timelineCreate).toHaveBeenCalledOnce()
    expect(h.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        beforeState: { status: 'AWAITING_INPUT', cancelRequested: true },
        afterState: expect.objectContaining({ requestedAt: requestedAt.toISOString() }),
      }),
    })
    expect(result).toEqual({
      id: 'run-1',
      status: 'CANCELLED',
      cancelRequestedAt: requestedAt,
      outcome: 'REQUESTED',
    })
  })

  it('appends one retained RESULT to the exact delegated parent on immediate cancellation', async () => {
    const h = harness()
    h.findFirst
      .mockResolvedValueOnce({
        id: 'run-1',
        status: 'QUEUED',
        cancelRequestedAt: null,
        startedAt: null,
        parentAgentRunId: 'parent-1',
        agentIdentityId: 'child-agent-1',
      })
      .mockResolvedValueOnce({ id: 'parent-1' })

    await expect(
      requestAgentRunCancellationAction(input, h.client as never),
    ).resolves.toMatchObject({ status: 'CANCELLED' })

    expect(h.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'parent-1', tenantId: 'tenant-1', venueId: 'venue-1' },
      select: { id: true },
    })
    expect(h.messageCreate).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentRunId: 'parent-1',
        agentIdentityId: 'child-agent-1',
        role: 'AGENT',
        messageType: 'RESULT',
        content:
          'agent-run:run-1 cancelled. Untrusted delegated terminal result: Cancellation was finalized by a platform administrator.',
        actorId: 'child-agent-1',
      },
    })
    expect(
      h.timelineCreate.mock.calls.filter(([call]) => call.data.agentRunId === 'parent-1'),
    ).toHaveLength(1)
  })

  it('fails a missing exact-scope delegated parent before child mutation', async () => {
    const h = harness()
    h.findFirst
      .mockResolvedValueOnce({
        id: 'run-1',
        status: 'AWAITING_APPROVAL',
        cancelRequestedAt: null,
        startedAt: new Date(),
        parentAgentRunId: 'missing-parent',
        agentIdentityId: 'child-agent-1',
      })
      .mockResolvedValueOnce(null)

    await expect(requestAgentRunCancellationAction(input, h.client as never)).rejects.toMatchObject(
      {
        code: 'LEASE_LOST',
      },
    )
    expect(h.updateMany).not.toHaveBeenCalled()
    expect(h.timelineCreate).not.toHaveBeenCalled()
    expect(h.messageCreate).not.toHaveBeenCalled()
    expect(h.auditCreate).not.toHaveBeenCalled()
  })

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
